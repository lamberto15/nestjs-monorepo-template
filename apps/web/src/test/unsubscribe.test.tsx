import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';
import { problem, server } from '@/test/server';

const UNSUBSCRIBE = '/v1/notifications/unsubscribe/:token';

type Seen = { token: string | readonly string[]; body: unknown };

// The one-click endpoint, answering 204 as the API does, and what it was sent.
function acceptUnsubscribes(seen: Seen[]) {
  server.use(
    http.post(UNSUBSCRIBE, async ({ params, request }) => {
      seen.push({ token: params.token!, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

describe("the notification mail's unsubscribe link", () => {
  it('unsubscribes only when the button is pressed, with the token, and needs no sign-in', async () => {
    const seen: Seen[] = [];
    acceptUnsubscribes(seen);
    const user = userEvent.setup();
    // The default `me` answer is 401: nobody is signed in.
    await renderApp('/unsubscribe?token=abc.def');

    const button = await screen.findByRole('button', { name: 'Unsubscribe' });
    expect(
      screen.getByText(/You will stop getting this kind of email/),
    ).toBeVisible();
    // A mail scanner that opens the link unsubscribes nobody.
    expect(seen).toEqual([]);

    await user.click(button);

    expect(
      await screen.findByText(
        "You are unsubscribed: we won't send you this kind of email again.",
      ),
    ).toBeVisible();
    expect(seen).toEqual([
      { token: 'abc.def', body: { 'List-Unsubscribe': 'One-Click' } },
    ]);
    // Done: no button to press again, and the way on is the settings page.
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Notification settings' }),
    ).toHaveAttribute('href', '/account/notifications');
  });

  it('sends one request however often the button is pressed', async () => {
    const seen: Seen[] = [];
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(UNSUBSCRIBE, async ({ params, request }) => {
        seen.push({ token: params.token!, body: await request.json() });
        await answered;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/unsubscribe?token=abc.def');

    const button = await screen.findByRole('button', { name: 'Unsubscribe' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    release();

    await screen.findByText(/You are unsubscribed/);
    expect(seen).toHaveLength(1);
  });

  it('says so when the link is invalid or expired, and does not offer to try again', async () => {
    server.use(http.post(UNSUBSCRIBE, () => problem(400, 'bad_request')));
    const user = userEvent.setup();
    await renderApp('/unsubscribe?token=stale');

    await user.click(
      await screen.findByRole('button', { name: 'Unsubscribe' }),
    );

    expect(
      await screen.findByText(/This link is invalid or has expired/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Notification settings' }),
    ).toBeVisible();
  });

  it('shows another failure and lets the person try again', async () => {
    const seen: Seen[] = [];
    let fail = true;
    server.use(
      http.post(UNSUBSCRIBE, async ({ params, request }) => {
        seen.push({ token: params.token!, body: await request.json() });
        return fail
          ? problem(503, 'service_unavailable')
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/unsubscribe?token=abc.def');

    await user.click(
      await screen.findByRole('button', { name: 'Unsubscribe' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'service_unavailable (test)',
    );

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));

    expect(await screen.findByText(/You are unsubscribed/)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it('asks for the email link again when the page is opened without a token', async () => {
    const seen: Seen[] = [];
    acceptUnsubscribes(seen);
    await renderApp('/unsubscribe');

    expect(
      await screen.findByText(
        'This link is incomplete. Open it again from the email.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
    expect(seen).toEqual([]);
  });

  it('works the same for someone who is signed in', async () => {
    const seen: Seen[] = [];
    acceptUnsubscribes(seen);
    useSignedIn([]);
    const user = userEvent.setup();
    await renderApp('/unsubscribe?token=abc.def');

    await user.click(
      await screen.findByRole('button', { name: 'Unsubscribe' }),
    );

    expect(await screen.findByText(/You are unsubscribed/)).toBeVisible();
    expect(seen).toHaveLength(1);
  });
});
