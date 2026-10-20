import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { findToast } from '@/test/toast';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';
import { problem, server, signedInUser } from '@/test/server';

// An account whose address was never proved, signed in (the route needs a
// session: POST /v1/auth/email/verification).
function useSignedInUnverified(extra: object = {}) {
  useSignedIn([]);
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        user: { ...signedInUser.user, emailVerified: false, ...extra },
      }),
    ),
  );
}

describe('resending the verification email', () => {
  it('offers it in a banner to a signed-in user whose address is unproved, with a toast on success', async () => {
    useSignedInUnverified();
    let sent = 0;
    server.use(
      http.post('/v1/auth/email/verification', () => {
        sent += 1;
        return HttpResponse.json({ accepted: true }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/');

    expect(
      await screen.findByText(/ada@example\.com is not verified/),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Resend the verification email' }),
    );

    expect(
      await findToast('Verification email sent. Check your mailbox.'),
    ).toBeVisible();
    expect(sent).toBe(1);
  });

  it('shows no banner once the address is proved', async () => {
    useSignedIn([]);
    await renderApp('/');
    await screen.findByText('Dashboard', { selector: 'h1' });
    expect(
      screen.queryByRole('button', { name: 'Resend the verification email' }),
    ).toBeNull();
  });

  it('shows no banner while an administrator acts as the user', async () => {
    useSignedInUnverified({
      impersonator: { id: 'admin', email: 'root@example.com' },
    });
    await renderApp('/');
    await screen.findByText('Dashboard', { selector: 'h1' });
    expect(
      screen.queryByRole('button', { name: 'Resend the verification email' }),
    ).toBeNull();
  });

  it('turns the button off with the reason once the API says 429', async () => {
    useSignedInUnverified();
    server.use(
      http.post('/v1/auth/email/verification', () =>
        problem(429, 'rate_limited'),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/');

    const button = await screen.findByRole('button', {
      name: 'Resend the verification email',
    });
    await user.click(button);

    expect(
      await screen.findByText(
        'Too many requests. Try again in about 15 minutes.',
      ),
    ).toBeVisible();
    expect(button).toBeDisabled();
  });

  it('toasts any other failure', async () => {
    useSignedInUnverified();
    server.use(
      http.post('/v1/auth/email/verification', () => problem(500, 'internal')),
    );
    const user = userEvent.setup();
    await renderApp('/');

    await user.click(
      await screen.findByRole('button', {
        name: 'Resend the verification email',
      }),
    );

    expect(await findToast('internal (test)')).toBeVisible();
  });

  it('is on the verify-email page for the signed-in user, with or without the link', async () => {
    useSignedInUnverified();
    const { router } = await renderApp('/verify-email?token=abc');
    expect(
      await screen.findByText('Lost the link, or it expired?'),
    ).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: 'Resend the verification email' }),
    ).not.toHaveLength(0);

    await router.navigate({ to: '/verify-email' });
    expect(
      await screen.findByText(/link is missing|incomplete|missing/i),
    ).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: 'Resend the verification email' }),
    ).not.toHaveLength(0);
  });

  it('is not on the verify-email page for nobody signed in (the API needs a session)', async () => {
    await renderApp('/verify-email?token=abc');
    expect(await screen.findByLabelText('Password')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Resend the verification email' }),
    ).toBeNull();
  });
});
