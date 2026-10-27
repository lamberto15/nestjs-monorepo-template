import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { peopleHandler } from '@/test/people';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

// The account forms' limits are the API's (lib/limits.test.ts compares the
// numbers): over one, the form says so in words and sends nothing.

/** Records the bodies a route received; the answer is not read by the pages. */
function capture(method: 'post' | 'patch', path: string) {
  const bodies: unknown[] = [];
  server.use(
    http[method](path, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({}, { status: 200 });
    }),
  );
  return bodies;
}

describe('the reset-password page', () => {
  it('refuses a password over 128 characters', async () => {
    const bodies = capture('post', '/v1/auth/password/reset');
    const user = userEvent.setup();
    await renderApp('/reset-password?token=abc');
    await user.click(await screen.findByLabelText('New password'));
    await user.paste('x'.repeat(129));
    await user.click(screen.getByLabelText('Confirm the password'));
    await user.paste('x'.repeat(129));
    await user.click(
      screen.getByRole('button', { name: 'Change the password' }),
    );
    expect(await screen.findByText('At most 128 characters.')).toBeVisible();
    expect(bodies).toEqual([]);
  });
});

describe('the accept-invitation page', () => {
  it('refuses a name over 120 and a password over 128 characters', async () => {
    const bodies = capture('post', '/v1/auth/invitations/accept');
    const user = userEvent.setup();
    await renderApp('/accept-invitation?token=abc');
    await user.click(await screen.findByLabelText('Name'));
    await user.paste('x'.repeat(121));
    await user.click(screen.getByLabelText('Password'));
    await user.paste('x'.repeat(129));
    await user.click(
      screen.getByRole('button', { name: 'Create the account and join' }),
    );
    expect(await screen.findByText('At most 120 characters.')).toBeVisible();
    expect(screen.getByText('At most 128 characters.')).toBeVisible();
    expect(bodies).toEqual([]);
  });
});

describe('the profile page', () => {
  it('refuses a name over 120 characters', async () => {
    useSignedIn([]);
    server.use(peopleHandler([]));
    const bodies = capture('patch', '/v1/auth/me');
    const user = userEvent.setup();
    await renderApp('/account/profile');
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.paste('x'.repeat(121));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('At most 120 characters.')).toBeVisible();
    expect(bodies).toEqual([]);
  });
});
