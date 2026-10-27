import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { problem, server } from '@/test/server';

const FORGOT = '/v1/auth/password/forgot';
const SENT = 'If the address has an account, a reset link is on its way.';

type Seen = { body: unknown; token: string | null };

// The request-a-reset endpoint, answering 202 as the API does for any
// address, and what it was sent.
function acceptRequests(seen: Seen[]) {
  server.use(
    http.post(FORGOT, async ({ request }) => {
      seen.push({
        body: await request.json(),
        token: request.headers.get('x-captcha-token'),
      });
      return HttpResponse.json({ accepted: true }, { status: 202 });
    }),
  );
}

const send = { name: 'Send the link' };

describe('the forgot-password page', () => {
  it('sends the address and answers the same whatever the address is', async () => {
    const seen: Seen[] = [];
    acceptRequests(seen);
    const user = userEvent.setup();
    // Nobody is signed in (the default `me` answer is 401).
    await renderApp('/forgot-password');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', send));

    expect(await screen.findByText(SENT)).toBeVisible();
    expect(seen).toEqual([{ body: { email: 'ada@example.com' }, token: null }]);
    // Done: no form to send again, and the way on is the sign-in page.
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByRole('button', send)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('validates the address before sending', async () => {
    const seen: Seen[] = [];
    acceptRequests(seen);
    const user = userEvent.setup();
    await renderApp('/forgot-password');

    await user.type(await screen.findByLabelText('Email'), 'not an address');
    await user.click(screen.getByRole('button', send));

    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeVisible();
    expect(seen).toEqual([]);
    expect(screen.queryByText(SENT)).toBeNull();

    // An empty form is refused the same way.
    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', send));
    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeVisible();
    expect(seen).toEqual([]);
  });

  it("shows the API's message on the address field", async () => {
    server.use(
      http.post(FORGOT, () =>
        problem(400, 'validation_failed', {
          errors: [{ path: 'email', message: 'That address is not allowed.' }],
        }),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/forgot-password');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', send));

    expect(
      await screen.findByText('That address is not allowed.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toBeInvalid();
    // The field took it: the form's alert (the problem's detail) is not shown.
    expect(screen.queryByText('validation_failed (test)')).toBeNull();
    expect(screen.queryByText(SENT)).toBeNull();
  });

  it('shows the problem of any other failure, and lets the person try again', async () => {
    const seen: Seen[] = [];
    let fail = true;
    server.use(
      http.post(FORGOT, async ({ request }) => {
        seen.push({
          body: await request.json(),
          token: request.headers.get('x-captcha-token'),
        });
        return fail
          ? problem(503, 'service_unavailable')
          : HttpResponse.json({ accepted: true }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/forgot-password');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', send));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'service_unavailable (test)',
    );
    // The form stays, with what was typed.
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
    expect(screen.queryByText(SENT)).toBeNull();

    fail = false;
    await user.click(screen.getByRole('button', send));

    expect(await screen.findByText(SENT)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it('asks for the bot check on a 403 captcha_required, then sends again with the token', async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(FORGOT, async ({ request }) => {
        const token = request.headers.get('x-captcha-token');
        seen.push({ body: await request.json(), token });
        return token
          ? HttpResponse.json({ accepted: true }, { status: 202 })
          : problem(403, 'captcha_required', {
              provider: 'stub',
              siteKey: null,
              action: 'forgot-password',
            });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/forgot-password');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    const button = screen.getByRole('button', send);
    await user.click(button);
    // The first attempt has no token: the challenge asks, nothing is said.
    await waitFor(() => {
      expect(seen).toHaveLength(1);
      expect(button).toBeEnabled();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(SENT)).toBeNull();

    await user.click(button);

    expect(await screen.findByText(SENT)).toBeVisible();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.token).toBeNull();
    // The development stand-in provider passes with a fresh stub token.
    expect(seen[1]!.token).toMatch(/^stub:pass:/);
    expect(seen[1]!.body).toEqual({ email: 'ada@example.com' });
  });

  it('links back to the sign-in page', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/forgot-password');

    await user.click(
      await screen.findByRole('link', { name: 'Back to sign in' }),
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sign-in'),
    );
  });
});
