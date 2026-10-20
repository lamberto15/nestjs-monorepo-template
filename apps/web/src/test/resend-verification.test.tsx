import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  // The 429 lock lives in sessionStorage: one test's must not reach the next.
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

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
      await screen.findByText(
        'This link is incomplete. Open it again from the email.',
      ),
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

  it('keeps the lock across buttons', async () => {
    useSignedInUnverified();
    server.use(
      http.post('/v1/auth/email/verification', () =>
        problem(429, 'rate_limited'),
      ),
    );
    const user = userEvent.setup();
    const { router } = await renderApp('/');
    const name = 'Resend the verification email';
    await user.click(await screen.findByRole('button', { name }));
    await screen.findByText(
      'Too many requests. Try again in about 15 minutes.',
    );

    // Another page's button (a new instance) is locked as well.
    await router.navigate({ to: '/verify-email' });
    await screen.findByText(
      'This link is incomplete. Open it again from the email.',
    );
    expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(
      screen.getByText('Too many requests. Try again in about 15 minutes.'),
    ).toBeVisible();
  });

  it('lifts the lock after 15 minutes', async () => {
    useSignedInUnverified();
    server.use(
      http.post('/v1/auth/email/verification', () =>
        problem(429, 'rate_limited'),
      ),
    );
    const name = 'Resend the verification email';
    const message = 'Too many requests. Try again in about 15 minutes.';
    await renderApp('/');
    const button = await screen.findByRole('button', { name });

    // Only the clock is faked (the page's own timers, msw's and
    // user-event's stay real): the 15-minute timer is caught as it is set,
    // the clock jumps past it, and the timer fires.
    vi.useFakeTimers({ toFake: ['Date'] });
    const timers: Array<{ run: () => void; ms: number }> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      run: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      timers.push({ run, ms: ms ?? 0 });
      return realSetTimeout(run, ms, ...rest);
    }) as typeof setTimeout);
    const user = userEvent.setup();
    await user.click(button);
    await screen.findByText(message);
    expect(button).toBeDisabled();

    const lift = timers.find((timer) => timer.ms > 14 * 60_000);
    expect(lift).toBeDefined();
    expect(lift!.ms).toBeLessThanOrEqual(15 * 60_000);
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    act(() => lift!.run());
    expect(button).toBeEnabled();
    expect(screen.queryByText(message)).toBeNull();
  });

  it('forgets the unverified address once it is verified', async () => {
    let verified = false;
    useSignedIn([]);
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          user: { ...signedInUser.user, emailVerified: verified },
        }),
      ),
      http.post('/v1/auth/email/verify', () => {
        verified = true;
        return HttpResponse.json({
          email: 'ada@example.com',
          emailVerified: true,
        });
      }),
    );
    const user = userEvent.setup();
    const { router } = await renderApp('/verify-email?token=abc');
    await user.type(await screen.findByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(
      await screen.findByText(/ada@example\.com is verified/),
    ).toBeVisible();

    // `me` was cached as unverified (60 s): the app must not show the banner.
    await router.navigate({ to: '/' });
    await screen.findByText('Dashboard', { selector: 'h1' });
    expect(
      screen.queryByRole('button', { name: 'Resend the verification email' }),
    ).toBeNull();
  });
});
