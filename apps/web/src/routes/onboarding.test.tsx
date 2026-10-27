import { http, HttpResponse } from 'msw/http';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

/** What the mutations in the cache hold: the typed passwords must not be there. */
const heldVariables = (queryClient: QueryClient) =>
  JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state.variables),
  );

/** The API for a first administrator mid-onboarding. */
function useOnboardingApi(
  options: {
    email?: boolean;
    password?: boolean;
    mfaRequired?: boolean;
  } = {},
) {
  const changes: unknown[] = [];
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        mfaEnrollmentRequired: options.mfaRequired ?? false,
        onboardingRequired:
          options.email === false && options.password === false
            ? null
            : {
                email: options.email ?? true,
                password: options.password ?? true,
              },
      }),
    ),
    http.get('/v1/features', () => HttpResponse.json(allFeatures)),
    http.get('/v1/auth/mfa', () =>
      HttpResponse.json({ enabled: false, remainingRecoveryCodes: 0 }),
    ),
    http.get('/v1/auth/passkeys', () => HttpResponse.json({ items: [] })),
    http.post('/v1/auth/email/change', async ({ request }) => {
      changes.push(await request.json());
      return HttpResponse.json({ accepted: true }, { status: 202 });
    }),
  );
  return changes;
}

describe('the administrator onboarding step', () => {
  it('blocks the app: any page leads to it, with the email and password steps', async () => {
    useOnboardingApi();
    const { history } = await renderApp('/');
    expect(
      await screen.findByRole('heading', {
        name: 'Finish setting up your account',
      }),
    ).toBeVisible();
    expect(history.location.pathname).toBe('/onboarding');
    expect(screen.getByText('A real email address')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Change the password' }),
    ).toBeVisible();
    expect(screen.getByText('Optional: more protection')).toBeVisible();
  });

  it('sends the new address with the current password', async () => {
    const changes = useOnboardingApi({ password: false });
    await renderApp('/onboarding');
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText('New email address'),
      'owner@acme-corp.dev',
    );
    await user.type(
      screen.getByLabelText('Current password'),
      'old-password-1',
    );
    await user.click(
      screen.getByRole('button', { name: 'Send the confirmation link' }),
    );
    await waitFor(() =>
      expect(changes).toEqual([
        { email: 'owner@acme-corp.dev', currentPassword: 'old-password-1' },
      ]),
    );
  });

  it('lets the user on once the password step is done (me is refreshed, no redirect back)', async () => {
    useOnboardingApi({ email: false });
    // The API clears the step when the password is changed; the page must ask again.
    let changed = false;
    const bodies: unknown[] = [];
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          mfaEnrollmentRequired: false,
          onboardingRequired: changed ? null : { email: false, password: true },
        }),
      ),
      http.post('/v1/auth/password/change', async ({ request }) => {
        bodies.push(await request.json());
        changed = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { history } = await renderApp('/onboarding');
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText('Current password'),
      'generated-password-1',
    );
    await user.type(
      screen.getByLabelText('New password'),
      'a-brand-new-passphrase-2026',
    );
    await user.type(
      screen.getByLabelText('Confirm the password'),
      'a-brand-new-passphrase-2026',
    );
    await user.click(
      screen.getByRole('button', { name: 'Change the password' }),
    );
    await user.click(await screen.findByText('Continue to the app'));
    expect(
      await screen.findByText('Dashboard', { selector: 'h1' }),
    ).toBeVisible();
    expect(history.location.pathname).toBe('/');
    expect(bodies).toEqual([
      {
        currentPassword: 'generated-password-1',
        newPassword: 'a-brand-new-passphrase-2026',
      },
    ]);
  });

  describe('does not keep the passwords in the mutation cache', () => {
    const sendAddress = async (queryClient: QueryClient) => {
      const user = userEvent.setup();
      await user.type(
        await screen.findByLabelText('New email address'),
        'owner@acme-corp.dev',
      );
      await user.type(
        screen.getByLabelText('Current password'),
        'old-password-1',
      );
      await user.click(
        screen.getByRole('button', { name: 'Send the confirmation link' }),
      );
      return queryClient;
    };
    const changePassword = async () => {
      const user = userEvent.setup();
      await user.type(
        await screen.findByLabelText('Current password'),
        'generated-password-1',
      );
      await user.type(
        screen.getByLabelText('New password'),
        'a-brand-new-passphrase-2026',
      );
      await user.type(
        screen.getByLabelText('Confirm the password'),
        'a-brand-new-passphrase-2026',
      );
      await user.click(
        screen.getByRole('button', { name: 'Change the password' }),
      );
    };

    it('after the address is sent', async () => {
      const changes = useOnboardingApi({ password: false });
      const { queryClient } = await renderApp('/onboarding');
      await sendAddress(queryClient);
      await waitFor(() => expect(changes).toHaveLength(1));
      await waitFor(() =>
        expect(heldVariables(queryClient)).not.toContain('old-password-1'),
      );
    });

    it('after the address is refused', async () => {
      useOnboardingApi({ password: false });
      server.use(
        http.post('/v1/auth/email/change', () => problem(409, 'email_taken')),
      );
      const { queryClient } = await renderApp('/onboarding');
      await sendAddress(queryClient);
      expect(await screen.findByText('email_taken (test)')).toBeVisible();
      await waitFor(() =>
        expect(heldVariables(queryClient)).not.toContain('old-password-1'),
      );
    });

    it('after the password is changed', async () => {
      useOnboardingApi({ email: false });
      const bodies: unknown[] = [];
      server.use(
        http.post('/v1/auth/password/change', async ({ request }) => {
          bodies.push(await request.json());
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const { queryClient } = await renderApp('/onboarding');
      await changePassword();
      await waitFor(() => expect(bodies).toHaveLength(1));
      await waitFor(() => {
        const held = heldVariables(queryClient);
        expect(held).not.toContain('generated-password-1');
        expect(held).not.toContain('a-brand-new-passphrase-2026');
      });
    });

    it('after the password is refused', async () => {
      useOnboardingApi({ email: false });
      server.use(
        http.post('/v1/auth/password/change', () =>
          problem(409, 'password_reused'),
        ),
      );
      const { queryClient } = await renderApp('/onboarding');
      await changePassword();
      expect(await screen.findByText('password_reused (test)')).toBeVisible();
      await waitFor(() => {
        const held = heldVariables(queryClient);
        expect(held).not.toContain('generated-password-1');
        expect(held).not.toContain('a-brand-new-passphrase-2026');
      });
    });
  });

  it('stays on the page when two-factor is required too (no redirect loop)', async () => {
    useOnboardingApi({ mfaRequired: true });
    const { history } = await renderApp('/');
    expect(
      await screen.findByRole('button', { name: 'Set up two-factor' }),
    ).toBeVisible();
    expect(history.location.pathname).toBe('/onboarding');
    expect(screen.queryByText('Optional: more protection')).toBeNull();
  });

  it('is done when nothing is pending: a way on, not a block', async () => {
    useOnboardingApi({ email: false, password: false });
    await renderApp('/onboarding');
    expect(await screen.findByText('Continue to the app')).toBeVisible();
  });
});
