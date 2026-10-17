import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server, signedInUser } from '@/test/server';

describe('the signed-in guard', () => {
  it('sends nobody to sign-in, with the deep link to come back to', async () => {
    const { router } = await renderApp('/account/profile?tab=1');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sign-in'),
    );
    expect(router.state.location.search).toEqual({
      redirect: '/account/profile?tab=1',
    });
  });

  it('sends a signed-in user away from sign-in, to a safe redirect only', async () => {
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(signedInUser)));
    const { router } = await renderApp(
      `/sign-in?redirect=${encodeURIComponent('//evil.example/x')}`,
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(
      await screen.findByText('Dashboard', { selector: 'h1' }),
    ).toBeVisible();
  });
});
