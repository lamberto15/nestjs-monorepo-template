import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { problem, server } from '@/test/server';

const RESET = '/v1/auth/password/reset';
const DONE = 'Your password was changed. Sign in with it.';
const CHOSEN = 'correct horse battery';

// The reset endpoint, answering 204 as the API does, and what it was sent.
function acceptResets(bodies: unknown[]) {
  server.use(
    http.post(RESET, async ({ request }) => {
      bodies.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  confirm: string,
) {
  await user.type(await screen.findByLabelText('New password'), first);
  await user.type(screen.getByLabelText('Confirm the password'), confirm);
}

const change = { name: 'Change the password' };

describe('the reset-password page', () => {
  it('sends the token with the new password only when the form is sent, and points to sign-in', async () => {
    const bodies: unknown[] = [];
    acceptResets(bodies);
    const user = userEvent.setup();
    // Nobody is signed in (the default `me` answer is 401).
    await renderApp('/reset-password?token=abc.def');

    await fill(user, CHOSEN, CHOSEN);
    // A mail scanner that opens the link resets nothing.
    expect(bodies).toEqual([]);
    await user.click(screen.getByRole('button', change));

    expect(await screen.findByText(DONE)).toBeVisible();
    // The confirmation is checked here and never sent.
    expect(bodies).toEqual([{ token: 'abc.def', password: CHOSEN }]);
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.queryByRole('button', change)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('asks for the email link again when the page is opened without a token', async () => {
    const bodies: unknown[] = [];
    acceptResets(bodies);
    await renderApp('/reset-password');

    expect(
      await screen.findByText(
        'This link is incomplete. Open it again from the email.',
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.queryByRole('button', change)).toBeNull();
    expect(bodies).toEqual([]);
  });

  it('refuses a password under 12 characters before sending', async () => {
    const bodies: unknown[] = [];
    acceptResets(bodies);
    const user = userEvent.setup();
    await renderApp('/reset-password?token=abc.def');

    await fill(user, 'too short', 'too short');
    await user.click(screen.getByRole('button', change));

    expect(await screen.findByText('At least 12 characters.')).toBeVisible();
    expect(bodies).toEqual([]);
    expect(screen.queryByText(DONE)).toBeNull();
  });

  it('refuses a confirmation that differs before sending', async () => {
    const bodies: unknown[] = [];
    acceptResets(bodies);
    const user = userEvent.setup();
    await renderApp('/reset-password?token=abc.def');

    await fill(user, CHOSEN, `${CHOSEN}!`);
    await user.click(screen.getByRole('button', change));

    expect(await screen.findByText("The passwords don't match.")).toBeVisible();
    expect(screen.getByLabelText('Confirm the password')).toBeInvalid();
    expect(bodies).toEqual([]);
    expect(screen.queryByText(DONE)).toBeNull();
  });

  it('says so when the link is invalid or has expired, and keeps the form', async () => {
    server.use(http.post(RESET, () => problem(400, 'invalid_token')));
    const user = userEvent.setup();
    await renderApp('/reset-password?token=stale');

    await fill(user, CHOSEN, CHOSEN);
    await user.click(screen.getByRole('button', change));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'invalid_token (test)',
    );
    expect(screen.queryByText(DONE)).toBeNull();
    expect(screen.getByRole('button', change)).toBeEnabled();
  });

  it("shows the API's message on the password field (a breached password)", async () => {
    server.use(
      http.post(RESET, () =>
        problem(400, 'validation_failed', {
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
    await renderApp('/reset-password?token=abc.def');

    await fill(user, CHOSEN, CHOSEN);
    await user.click(screen.getByRole('button', change));

    expect(
      await screen.findByText('That password appears in a data breach.'),
    ).toBeVisible();
    expect(screen.getByLabelText('New password')).toBeInvalid();
    // The field took it: the form's alert (the problem's detail) is not shown.
    expect(screen.queryByText('validation_failed (test)')).toBeNull();
    expect(screen.queryByText(DONE)).toBeNull();
  });

  it('lets the person send again after a failure', async () => {
    const bodies: unknown[] = [];
    let fail = true;
    server.use(
      http.post(RESET, async ({ request }) => {
        bodies.push(await request.json());
        return fail
          ? problem(503, 'service_unavailable')
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/reset-password?token=abc.def');

    await fill(user, CHOSEN, CHOSEN);
    await user.click(screen.getByRole('button', change));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'service_unavailable (test)',
    );

    fail = false;
    await user.click(screen.getByRole('button', change));

    expect(await screen.findByText(DONE)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(bodies).toHaveLength(2);
  });
});
