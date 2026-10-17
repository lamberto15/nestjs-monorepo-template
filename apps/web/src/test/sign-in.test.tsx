import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { allMethods, problem, server, signedInUser } from '@/test/server';

describe('the sign-in page', () => {
  it('signs in with a password, asks for the code, then goes where the user was headed', async () => {
    let signedIn = false;
    const bodies: unknown[] = [];
    server.use(
      http.get('/v1/auth/me', () =>
        signedIn
          ? HttpResponse.json(signedInUser)
          : problem(401, 'unauthorized'),
      ),
      http.post('/v1/auth/sign-in', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ signedIn: false, mfaRequired: true });
      }),
      http.post('/v1/auth/mfa/verify', async ({ request }) => {
        bodies.push(await request.json());
        signedIn = true;
        return HttpResponse.json({ signedIn: true, mfaRequired: false });
      }),
    );
    const user = userEvent.setup();
    const { router } = await renderApp(
      '/sign-in?redirect=%2Faccount%2Fprofile',
    );

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The second factor: six digits submit by themselves.
    await user.type(
      await screen.findByLabelText('Authentication code'),
      '123456',
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/account/profile'),
    );
    expect(bodies).toEqual([
      { email: 'ada@example.com', password: 'correct horse' },
      { code: '123456' },
    ]);
  });

  it('shows the problem of a refused sign-in', async () => {
    server.use(
      http.post('/v1/auth/sign-in', () => problem(401, 'unauthorized')),
    );
    const user = userEvent.setup();
    await renderApp('/sign-in');
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'unauthorized (test)',
    );
  });

  it('validates before sending', async () => {
    const user = userEvent.setup();
    await renderApp('/sign-in');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeVisible();
    expect(screen.getByText('Enter your password.')).toBeVisible();
  });

  it('follows GET /v1/auth/methods: sign-up, providers, email links', async () => {
    await renderApp('/sign-in');
    expect(await screen.findByRole('link', { name: 'Sign up' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toHaveAttribute('href', '/v1/auth/oidc/google/login?redirectTo=%2F');
    expect(
      screen.getByRole('button', { name: 'Email me a sign-in link' }),
    ).toBeVisible();
  });

  it('hides what the deployment has off', async () => {
    server.use(
      http.get('/v1/auth/methods', () =>
        HttpResponse.json({
          ...allMethods,
          signUp: false,
          magicLink: false,
          providers: [],
        }),
      ),
    );
    await renderApp('/sign-in');
    expect(await screen.findByLabelText('Email')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sign up' })).toBeNull();
    expect(screen.queryByText('Or continue with')).toBeNull();
    expect(screen.queryByRole('button', { name: /Google/ })).toBeNull();
  });
});
