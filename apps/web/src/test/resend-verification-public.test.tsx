import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';
import { problem, server, signedInUser } from '@/test/server';

const RESEND = '/v1/auth/email/verification/resend';
const SENT =
  'If this address has an account waiting for confirmation, we sent a new link.';
const LIMITED = 'Too many requests. Try again in about 15 minutes.';

type Seen = { body: unknown; token: string | null };

// The public resend, answering 202 as the API does for any address.
function acceptResends(seen: Seen[]) {
  server.use(
    http.post(RESEND, async ({ request }) => {
      seen.push({
        body: await request.json(),
        token: request.headers.get('x-captcha-token'),
      });
      return HttpResponse.json({ accepted: true }, { status: 202 });
    }),
  );
}

async function signUp(user: ReturnType<typeof userEvent.setup>) {
  server.use(
    http.post('/v1/auth/sign-up', () =>
      HttpResponse.json({ id: 'u1' }, { status: 201 }),
    ),
  );
  await renderApp('/sign-up');
  await user.type(await screen.findByLabelText('Name'), 'Ada Lovelace');
  await user.type(screen.getByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByText(/Check your mailbox/);
}

// A sign-in the API refuses because the address is not proved yet.
async function signInUnverified(user: ReturnType<typeof userEvent.setup>) {
  server.use(
    http.post('/v1/auth/sign-in', () => problem(403, 'email_unverified')),
  );
  await renderApp('/sign-in');
  await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

// Another sign-in attempt on the same page (the refusal brings the resend
// back for the address typed now).
async function signInAs(
  user: ReturnType<typeof userEvent.setup>,
  email: string,
) {
  const field = screen.getByLabelText('Email');
  await user.clear(field);
  await user.type(field, email);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const again = { name: 'Send the link again' };

describe('resending the verification email without a session', () => {
  // The 429 lock lives in sessionStorage: one test's must not reach the next.
  afterEach(() => sessionStorage.clear());

  it('is on the sign-up confirmation, and sends the address just signed up with', async () => {
    const seen: Seen[] = [];
    acceptResends(seen);
    const user = userEvent.setup();
    await signUp(user);

    await user.click(screen.getByRole('button', again));

    expect(await screen.findByText(SENT)).toBeVisible();
    expect(seen).toEqual([{ body: { email: 'ada@example.com' }, token: null }]);
  });

  it('is offered after a sign-in refused with email_unverified, for the typed address', async () => {
    const seen: Seen[] = [];
    acceptResends(seen);
    const user = userEvent.setup();
    await signInUnverified(user);

    await user.click(await screen.findByRole('button', again));

    expect(await screen.findByText(SENT)).toBeVisible();
    expect(seen).toEqual([{ body: { email: 'ada@example.com' }, token: null }]);
  });

  it('is not offered after a refusal of another kind', async () => {
    server.use(
      http.post('/v1/auth/sign-in', () => problem(401, 'unauthorized')),
    );
    const user = userEvent.setup();
    await renderApp('/sign-in');
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', again)).toBeNull();
  });

  it('turns the button off with the reason once the API says 429', async () => {
    server.use(http.post(RESEND, () => problem(429, 'rate_limited')));
    const user = userEvent.setup();
    await signUp(user);

    const button = screen.getByRole('button', again);
    await user.click(button);

    expect(await screen.findByText(LIMITED)).toBeVisible();
    expect(button).toBeDisabled();
    expect(screen.queryByText(SENT)).toBeNull();
  });

  it('shows the problem of any other failure', async () => {
    server.use(http.post(RESEND, () => problem(500, 'internal')));
    const user = userEvent.setup();
    await signUp(user);

    await user.click(screen.getByRole('button', again));

    expect(await screen.findByText('internal (test)')).toBeVisible();
  });

  it('asks for the bot check on a 403 captcha_required, then sends again with the token', async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(RESEND, async ({ request }) => {
        const token = request.headers.get('x-captcha-token');
        seen.push({ body: await request.json(), token });
        return token
          ? HttpResponse.json({ accepted: true }, { status: 202 })
          : problem(403, 'captcha_required', {
              provider: 'stub',
              siteKey: null,
              action: 'resend-verification',
            });
      }),
    );
    const user = userEvent.setup();
    await signUp(user);

    // The first attempt has no token: the challenge asks, nothing is said.
    const button = screen.getByRole('button', again);
    await user.click(button);
    await waitFor(() => {
      expect(seen).toHaveLength(1);
      expect(button).toBeEnabled();
    });
    await user.click(button);

    expect(await screen.findByText(SENT)).toBeVisible();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.token).toBeNull();
    // The development stand-in provider passes with a fresh stub token.
    expect(seen[1]!.token).toMatch(/^stub:pass:/);
  });

  describe('the 429 lock', () => {
    async function lockAda(user: ReturnType<typeof userEvent.setup>) {
      server.use(http.post(RESEND, () => problem(429, 'rate_limited')));
      await signInUnverified(user);
      await user.click(await screen.findByRole('button', again));
      await screen.findByText(LIMITED);
    }

    it('is for the address: another address keeps its button', async () => {
      const user = userEvent.setup();
      await lockAda(user);

      await signInAs(user, 'grace@example.com');

      expect(await screen.findByRole('button', again)).toBeEnabled();
      expect(screen.queryByText(LIMITED)).toBeNull();
    });

    it('is shared by spellings of the address the API counts as one', async () => {
      const user = userEvent.setup();
      await lockAda(user);

      await signInAs(user, 'ADA@Example.com');

      expect(await screen.findByRole('button', again)).toBeDisabled();
      expect(screen.getByText(LIMITED)).toBeVisible();
    });

    it('survives a remount of the button', async () => {
      const user = userEvent.setup();
      await lockAda(user);

      // A new sign-in attempt unmounts the resend and mounts it again.
      await signInAs(user, 'ada@example.com');

      expect(await screen.findByRole('button', again)).toBeDisabled();
      expect(screen.getByText(LIMITED)).toBeVisible();
    });

    it('does not touch the signed-in resend, which has its own lock', async () => {
      const user = userEvent.setup();
      await lockAda(user);
      // The sign-in page goes; the lock stays in sessionStorage.
      cleanup();

      useSignedIn([]);
      server.use(
        http.get('/v1/auth/me', () =>
          HttpResponse.json({
            ...signedInUser,
            user: { ...signedInUser.user, emailVerified: false },
          }),
        ),
        http.post('/v1/auth/email/verification', () =>
          problem(429, 'rate_limited'),
        ),
      );
      await renderApp('/');
      const name = 'Resend the verification email';
      const button = await screen.findByRole('button', { name });
      expect(button).toBeEnabled();

      await userEvent.click(button);
      expect(await screen.findByText(LIMITED)).toBeVisible();
      expect(button).toBeDisabled();
    });

    it('does not bring the old confirmation back when it is over', async () => {
      const seen: Seen[] = [];
      const user = userEvent.setup();
      await signUp(user);
      acceptResends(seen);
      await user.click(screen.getByRole('button', again));
      await screen.findByText(SENT);

      server.use(http.post(RESEND, () => problem(429, 'rate_limited')));
      await user.click(screen.getByRole('button', again));

      await screen.findByText(LIMITED);
      expect(screen.queryByText(SENT)).toBeNull();
      expect(screen.getByText(LIMITED)).toHaveAttribute('role', 'status');
    });
  });
});
