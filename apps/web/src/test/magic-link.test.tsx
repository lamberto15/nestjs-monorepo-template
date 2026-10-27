import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';
import { problem, server, signedInUser } from '@/test/server';

const VERIFY = '/v1/auth/magic-link/verify';
const MFA = '/v1/auth/mfa/verify';

type Answer = { signedIn: boolean; mfaRequired: boolean; redirectTo?: string };

// The API's side of the link: `me` is nobody until a verification signs in,
// and the verification answers as given. Returns what it was sent.
function linkAnswers(answer: Answer, signsIn = !answer.mfaRequired) {
  const state = { signedIn: false, bodies: [] as unknown[] };
  server.use(
    http.get('/v1/auth/me', () =>
      state.signedIn
        ? HttpResponse.json(signedInUser)
        : problem(401, 'unauthorized'),
    ),
    http.post(VERIFY, async ({ request }) => {
      state.bodies.push(await request.json());
      state.signedIn = signsIn;
      return HttpResponse.json(answer);
    }),
  );
  return state;
}

const signIn = { name: 'Sign in' };

describe('the magic-link page', () => {
  // The pages signed in (where the link leads) answer their switches.
  beforeEach(() => {
    useSignedIn([]);
  });

  it('signs in only when the button is pressed, with the token, then goes where the link leads', async () => {
    const state = linkAnswers({
      signedIn: true,
      mfaRequired: false,
      redirectTo: '/account/profile',
    });
    const user = userEvent.setup();
    const { router } = await renderApp('/magic-link?token=abc.def');

    const button = await screen.findByRole('button', signIn);
    expect(
      screen.getByText('Continue to sign in with this link.'),
    ).toBeVisible();
    // A mail scanner that opens the link (and runs its script) spends nothing.
    expect(state.bodies).toEqual([]);

    await user.click(button);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/account/profile'),
    );
    expect(state.bodies).toEqual([{ token: 'abc.def' }]);
  });

  it('goes to the home page when the link names no page', async () => {
    const state = linkAnswers({ signedIn: true, mfaRequired: false });
    const user = userEvent.setup();
    const { router } = await renderApp('/magic-link?token=abc.def');

    await user.click(await screen.findByRole('button', signIn));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(state.bodies).toEqual([{ token: 'abc.def' }]);
    expect(router.state.location.search).toEqual({});
  });

  it('does not follow a redirect that leaves this app', async () => {
    linkAnswers({
      signedIn: true,
      mfaRequired: false,
      redirectTo: 'https://evil.example/phish',
    });
    const user = userEvent.setup();
    const { router } = await renderApp('/magic-link?token=abc.def');

    await user.click(await screen.findByRole('button', signIn));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(router.state.location.href).toBe('/');
  });

  it('asks for the email link again when the page is opened without a token', async () => {
    const state = linkAnswers({ signedIn: true, mfaRequired: false });
    await renderApp('/magic-link');

    expect(
      await screen.findByText(
        'This link is incomplete. Open it again from the email.',
      ),
    ).toBeVisible();
    // The only way on is the sign-in page: nothing here verifies a link.
    expect(
      screen.queryByText('Continue to sign in with this link.'),
    ).toBeNull();
    expect(screen.getByRole('button', signIn)).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(state.bodies).toEqual([]);
  });

  it('asks for the second factor when the account has one, then goes where that answer leads', async () => {
    const state = linkAnswers({ signedIn: false, mfaRequired: true });
    const codes: unknown[] = [];
    server.use(
      http.post(MFA, async ({ request }) => {
        codes.push(await request.json());
        state.signedIn = true;
        return HttpResponse.json({
          signedIn: true,
          mfaRequired: false,
          redirectTo: '/account/profile',
        });
      }),
    );
    const user = userEvent.setup();
    const { router } = await renderApp('/magic-link?token=abc.def');

    await user.click(await screen.findByRole('button', signIn));
    // The pending session is the cookie the link set: six digits submit by themselves.
    await user.type(
      await screen.findByLabelText('Authentication code'),
      '123456',
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/account/profile'),
    );
    expect(state.bodies).toEqual([{ token: 'abc.def' }]);
    expect(codes).toEqual([{ code: '123456' }]);
  });

  it('goes back to the link from the second factor with "Start over"', async () => {
    const state = linkAnswers({ signedIn: false, mfaRequired: true });
    const user = userEvent.setup();
    await renderApp('/magic-link?token=abc.def');

    await user.click(await screen.findByRole('button', signIn));
    await screen.findByLabelText('Authentication code');
    await user.click(screen.getByRole('button', { name: 'Start over' }));

    expect(await screen.findByRole('button', signIn)).toBeVisible();
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    expect(state.bodies).toHaveLength(1);
  });

  it('says so when the link is invalid or has expired, with the way back to sign-in', async () => {
    server.use(http.post(VERIFY, () => problem(400, 'invalid_token')));
    const user = userEvent.setup();
    const { router } = await renderApp('/magic-link?token=stale');

    await user.click(await screen.findByRole('button', signIn));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'invalid_token (test)',
    );
    // A link works once: nothing to press again, only the way to sign-in.
    expect(
      screen.queryByText('Continue to sign in with this link.'),
    ).toBeNull();
    expect(screen.getByRole('button', signIn)).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(router.state.location.pathname).toBe('/magic-link');
  });

  it('sends one request however often the button is pressed', async () => {
    const bodies: unknown[] = [];
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(VERIFY, async ({ request }) => {
        bodies.push(await request.json());
        await answered;
        return HttpResponse.json({ signedIn: false, mfaRequired: true });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/magic-link?token=abc.def');

    const button = await screen.findByRole('button', signIn);
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    release();

    await screen.findByLabelText('Authentication code');
    expect(bodies).toHaveLength(1);
  });
});
