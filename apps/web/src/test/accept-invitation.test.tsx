import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';
import { problem, server, signedInUser } from '@/test/server';

const ACCEPT = '/v1/auth/invitations/accept';
const TENANT = '/v1/auth/tenant';
const CHOSEN = 'correct horse battery';
const TENANT_ID = '0199a3f2-0000-7000-8000-0000000000bb';
const CREATED = 'Your account is ready. Sign in to start.';
const SIGN_IN_FIRST =
  'This address already has an account: sign in, then open the invitation again.';

// The accept endpoint, answering 200 as the API does, and what it was sent.
function acceptInvitations(bodies: unknown[], accountCreated = true) {
  server.use(
    http.post(ACCEPT, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ tenantId: TENANT_ID, accountCreated });
    }),
  );
}

async function fillAccount(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  chosen: string,
) {
  const field = await screen.findByLabelText('Name');
  await user.type(field, name);
  await user.type(screen.getByLabelText('Password'), chosen);
}

const create = { name: 'Create the account and join' };

describe('the accept-invitation page', () => {
  it('asks for the email link again when the page is opened without a token', async () => {
    const bodies: unknown[] = [];
    acceptInvitations(bodies);
    await renderApp('/accept-invitation');

    expect(
      await screen.findByText(
        'This link is incomplete. Open it again from the email.',
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByRole('button', create)).toBeNull();
    expect(bodies).toEqual([]);
  });

  describe('for an address without an account (nobody is signed in)', () => {
    it('makes the account with the chosen name and password, then points to sign-in', async () => {
      const bodies: unknown[] = [];
      acceptInvitations(bodies);
      const user = userEvent.setup();
      await renderApp('/accept-invitation?token=abc.def');

      await fillAccount(user, '  Ada Lovelace ', CHOSEN);
      // Nothing is accepted by opening the link.
      expect(bodies).toEqual([]);
      await user.click(screen.getByRole('button', create));

      expect(await screen.findByText(CREATED)).toBeVisible();
      // The name is trimmed; the token rides along.
      expect(bodies).toEqual([
        { token: 'abc.def', name: 'Ada Lovelace', password: CHOSEN },
      ]);
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(screen.queryByRole('button', create)).toBeNull();
      // A new account signs in afterwards, then on to the home page.
      expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute(
        'href',
        '/sign-in?redirect=%2F',
      );
    });

    it('offers sign-in for an account that exists, and comes back to this invitation after it', async () => {
      const user = userEvent.setup();
      const { router } = await renderApp('/accept-invitation?token=abc.def');

      const link = await screen.findByRole('link', { name: 'Sign in' });
      expect(link).toHaveAttribute(
        'href',
        '/sign-in?redirect=%2Faccept-invitation%3Ftoken%3Dabc.def',
      );
      await user.click(link);

      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/sign-in'),
      );
      expect(router.state.location.search).toEqual({
        redirect: '/accept-invitation?token=abc.def',
      });
    });

    it('validates the name and the password before sending', async () => {
      const bodies: unknown[] = [];
      acceptInvitations(bodies);
      const user = userEvent.setup();
      await renderApp('/accept-invitation?token=abc.def');

      // Spaces are no name.
      await fillAccount(user, '   ', 'too short');
      await user.click(screen.getByRole('button', create));

      expect(await screen.findByText('Enter a name.')).toBeVisible();
      expect(screen.getByText('At least 12 characters.')).toBeVisible();
      expect(bodies).toEqual([]);
      expect(screen.queryByText(CREATED)).toBeNull();
    });

    it('tells the person to sign in first when the address has an account (401 sign_in_required)', async () => {
      server.use(http.post(ACCEPT, () => problem(401, 'sign_in_required')));
      const user = userEvent.setup();
      await renderApp('/accept-invitation?token=abc.def');

      await fillAccount(user, 'Ada Lovelace', CHOSEN);
      await user.click(screen.getByRole('button', create));

      expect(await screen.findByText(SIGN_IN_FIRST)).toBeVisible();
      // The form is gone, and sign-in leads back to this invitation.
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute(
        'href',
        '/sign-in?redirect=%2Faccept-invitation%3Ftoken%3Dabc.def',
      );
    });

    it('says so when the invitation is invalid or has expired, and keeps the form', async () => {
      server.use(http.post(ACCEPT, () => problem(400, 'invitation_invalid')));
      const user = userEvent.setup();
      await renderApp('/accept-invitation?token=stale');

      await fillAccount(user, 'Ada Lovelace', CHOSEN);
      await user.click(screen.getByRole('button', create));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'invitation_invalid (test)',
      );
      expect(screen.queryByText(CREATED)).toBeNull();
      expect(screen.getByLabelText('Name')).toHaveValue('Ada Lovelace');
    });

    it("shows the API's message on the password field (a breached password)", async () => {
      server.use(
        http.post(ACCEPT, () =>
          problem(400, 'password_breached', {
            errors: [
              {
                path: 'password',
                message: 'That password appears in a data breach.',
              },
            ],
          }),
        ),
      );
      const user = userEvent.setup();
      await renderApp('/accept-invitation?token=abc.def');

      await fillAccount(user, 'Ada Lovelace', CHOSEN);
      await user.click(screen.getByRole('button', create));

      expect(
        await screen.findByText('That password appears in a data breach.'),
      ).toBeVisible();
      expect(screen.getByLabelText('Password')).toBeInvalid();
      // The field took it: the form's alert (the problem's detail) is not shown.
      expect(screen.queryByText('password_breached (test)')).toBeNull();
      expect(screen.queryByText(CREATED)).toBeNull();
    });
  });

  describe('for someone signed in', () => {
    it('joins the tenant as that account, then switches to it and goes to the home page', async () => {
      useSignedIn([]);
      const calls: [string, unknown][] = [];
      server.use(
        http.post(ACCEPT, async ({ request }) => {
          calls.push(['accept', await request.json()]);
          return HttpResponse.json({
            tenantId: TENANT_ID,
            accountCreated: false,
          });
        }),
        http.post(TENANT, async ({ request }) => {
          calls.push(['switch', await request.json()]);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = userEvent.setup();
      const { router } = await renderApp('/accept-invitation?token=abc.def');

      expect(await screen.findByText('Join as ada@example.com.')).toBeVisible();
      // No form: the account exists.
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(calls).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Accept and join' }));

      await waitFor(() => expect(router.state.location.pathname).toBe('/'));
      // Only the token is sent (nothing is set for an account that has all);
      // the tenant just joined is the one acted in.
      expect(calls).toEqual([
        ['accept', { token: 'abc.def' }],
        ['switch', { tenantId: TENANT_ID }],
      ]);
    });

    it('stays on the page, and says why, when the invitation is for another account', async () => {
      useSignedIn([]);
      const switched: unknown[] = [];
      server.use(
        http.post(ACCEPT, () => problem(403, 'invitation_other_account')),
        http.post(TENANT, async ({ request }) => {
          switched.push(await request.json());
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = userEvent.setup();
      const { router } = await renderApp('/accept-invitation?token=abc.def');

      const button = await screen.findByRole('button', {
        name: 'Accept and join',
      });
      await user.click(button);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'invitation_other_account (test)',
      );
      expect(switched).toEqual([]);
      expect(router.state.location.pathname).toBe('/accept-invitation');
      expect(button).toBeEnabled();
    });

    it('signs out from "Not you?" and goes to sign-in', async () => {
      useSignedIn([]);
      let signedIn = true;
      const bodies: unknown[] = [];
      server.use(
        http.get('/v1/auth/me', () =>
          signedIn
            ? HttpResponse.json(signedInUser)
            : problem(401, 'unauthorized'),
        ),
        http.post('/v1/auth/sign-out', () => {
          signedIn = false;
          return new HttpResponse(null, { status: 204 });
        }),
        http.post(ACCEPT, async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({
            tenantId: TENANT_ID,
            accountCreated: false,
          });
        }),
      );
      const user = userEvent.setup();
      const { router } = await renderApp('/accept-invitation?token=abc.def');

      await user.click(
        await screen.findByRole('button', { name: 'Not you? Sign out' }),
      );

      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/sign-in'),
      );
      // Signing out accepts nothing.
      expect(bodies).toEqual([]);
    });
  });
});
