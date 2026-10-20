import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { settleReauthentication } from '@/lib/reauth';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

type Identity = { provider: string; email: string | null; createdAt: string };

const google: Identity = {
  provider: 'google',
  email: 'ada@gmail.com',
  createdAt: '2026-09-01T08:00:00.000Z',
};
const github: Identity = {
  provider: 'github',
  email: null,
  createdAt: '2026-09-02T08:00:00.000Z',
};

/** The security page's API; a write changes what the next read brings. */
function useSecurityApi(
  options: {
    identities?: Identity[];
    providers?: string[];
    recentUntil?: string | null;
    emailVerified?: boolean;
  } = {},
) {
  const state = {
    identities: options.identities ?? [],
    reads: 0,
    deleted: [] as string[],
    deleteCalls: 0,
    lastMethod: false,
    stepUpFirst: false,
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        user: {
          ...signedInUser.user,
          emailVerified: options.emailVerified ?? true,
        },
        authentication: {
          ...signedInUser.authentication,
          recentUntil:
            options.recentUntil === undefined
              ? '2999-01-01T00:00:00.000Z'
              : options.recentUntil,
        },
      }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false, passkeys: false }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/auth/methods', () =>
      HttpResponse.json({
        password: true,
        signUp: false,
        magicLink: false,
        passkeys: false,
        providers: options.providers ?? ['google', 'github'],
        captcha: null,
      }),
    ),
    http.get('/v1/auth/mfa', () =>
      HttpResponse.json({ enabled: false, remainingRecoveryCodes: 0 }),
    ),
    http.get('/v1/auth/sessions', () => HttpResponse.json({ items: [] })),
    http.get('/v1/auth/identities', () => {
      state.reads++;
      return HttpResponse.json({ items: state.identities });
    }),
    http.delete('/v1/auth/identities/:provider', ({ params }) => {
      state.deleteCalls++;
      if (state.stepUpFirst && state.deleteCalls === 1) {
        return problem(403, 'reauthentication_required', {
          methods: ['password'],
        });
      }
      if (state.lastMethod) {
        return problem(409, 'last_sign_in_method', {
          detail:
            'This is your only way to sign in: set a password or add a passkey first.',
        });
      }
      state.deleted.push(String(params.provider));
      state.identities = state.identities.filter(
        (identity) => identity.provider !== params.provider,
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/v1/auth/reauthenticate', () => HttpResponse.json({ ok: true })),
  );
  return state;
}

async function section() {
  const heading = await screen.findByText('Connected accounts');
  return within(heading.closest('[data-slot="card"]') as HTMLElement);
}

describe('the connected accounts section', () => {
  // The re-authenticate dialog's request is module state: never left open.
  afterEach(() => act(() => settleReauthentication(false)));

  it('lists the connected providers and offers the others', async () => {
    useSecurityApi({ identities: [google] });
    await renderApp('/account/security');
    const card = await section();
    expect(await card.findByText('Google')).toBeVisible();
    expect(card.getByText(/ada@gmail\.com · connected /)).toBeVisible();
    expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    // Only the provider that is not connected yet, as the API's own flow.
    expect(card.queryByRole('button', { name: 'Connect Google' })).toBeNull();
    expect(
      card.getByRole('button', { name: 'Connect GitHub' }),
    ).toHaveAttribute(
      'href',
      '/v1/auth/oidc/github/login?link=true&redirectTo=%2Faccount%2Fsecurity',
    );
  });

  it('says none is connected, and offers every provider', async () => {
    useSecurityApi();
    await renderApp('/account/security');
    const card = await section();
    expect(await card.findByText('No accounts connected yet.')).toBeVisible();
    expect(card.getByRole('button', { name: 'Connect Google' })).toBeVisible();
    expect(card.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
  });

  it('is absent when nothing is connected and the deployment has no provider', async () => {
    const api = useSecurityApi({ providers: [] });
    await renderApp('/account/security');
    expect(await screen.findByText('Sessions')).toBeVisible();
    await waitFor(() => expect(api.reads).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText('Connected accounts')).toBeNull();
  });

  it('asks before disconnecting, then refreshes the list', async () => {
    const api = useSecurityApi({ identities: [google, github] });
    await renderApp('/account/security');
    const card = await section();
    const user = userEvent.setup();
    expect(await card.findByText('GitHub')).toBeVisible();
    const reads = api.reads;
    await user.click(card.getAllByRole('button', { name: 'Disconnect' })[0]!);
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Disconnect Google?',
    });
    expect(api.deleted).toEqual([]);
    await user.click(
      within(dialog).getByRole('button', { name: 'Disconnect' }),
    );
    await waitFor(() => expect(api.deleted).toEqual(['google']));
    // Gone from the list, which was read again, and offered to connect again.
    await waitFor(() => expect(card.queryByText('ada@gmail.com')).toBeNull());
    expect(api.reads).toBeGreaterThan(reads);
    expect(card.getByRole('button', { name: 'Connect Google' })).toBeVisible();
    expect(card.getByText('GitHub')).toBeVisible();
  });

  it("shows the API's refusal of the last way to sign in, and keeps the account connected", async () => {
    const api = useSecurityApi({ identities: [google] });
    api.lastMethod = true;
    await renderApp('/account/security');
    const card = await section();
    const user = userEvent.setup();
    await user.click(await card.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Disconnect' }),
    );
    expect(
      await findToast(
        'This is your only way to sign in: set a password or add a passkey first.',
      ),
    ).toBeVisible();
    expect(api.deleted).toEqual([]);
    // The dialog stays to try again; the list is as it was.
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(card.getByText(/ada@gmail\.com/)).toBeInTheDocument();
  });

  it('passes the step-up through, then sends the disconnect again', async () => {
    const api = useSecurityApi({ identities: [google] });
    api.stepUpFirst = true;
    await renderApp('/account/security');
    const card = await section();
    const user = userEvent.setup();
    await user.click(await card.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Disconnect' }),
    );
    const reauth = await screen.findByRole('dialog', { name: /confirm/i });
    await user.type(within(reauth).getByLabelText(/Password/), 'secret');
    await user.click(within(reauth).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(api.deleted).toEqual(['google']));
    expect(api.deleteCalls).toBe(2);
    expect(await card.findByText('No accounts connected yet.')).toBeVisible();
  });

  it('asks to confirm it is you before connecting from a stale sign-in', async () => {
    useSecurityApi({ recentUntil: '2020-01-01T00:00:00.000Z' });
    server.use(
      http.get('/v1/auth/reauthenticate', () =>
        HttpResponse.json({
          methods: ['password'],
          mfaRequired: false,
          authenticatedAt: '2020-01-01T00:00:00.000Z',
          recentUntil: '2020-01-01T00:10:00.000Z',
          maxAge: 600,
        }),
      ),
    );
    await renderApp('/account/security');
    const card = await section();
    const user = userEvent.setup();
    await user.click(
      await card.findByRole('button', { name: 'Connect Google' }),
    );
    expect(
      await screen.findByRole('dialog', { name: /confirm/i }),
    ).toBeVisible();
  });

  it('shows what the API sent the browser back with', async () => {
    useSecurityApi();
    await renderApp('/account/security?error=reauthentication_required');
    expect(
      await screen.findByText("For this, confirm it's you: sign in again."),
    ).toBeVisible();
  });

  it('does not offer to connect an account while the email is unverified', async () => {
    useSecurityApi({ emailVerified: false });
    await renderApp('/account/security');
    const card = await section();
    expect(
      await card.findByText('Verify your email address to connect an account.'),
    ).toBeVisible();
    expect(card.queryByRole('button', { name: /Connect/ })).toBeNull();
  });
});
