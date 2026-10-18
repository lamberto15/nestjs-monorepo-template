import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { problem, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';

async function signOutFromMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
}

describe('signing out', () => {
  it('stays signed in, and says why, when the API fails', async () => {
    server.use(
      http.get('/v1/auth/me', () => HttpResponse.json(signedInUser)),
      http.post('/v1/auth/sign-out', () => problem(503, 'unavailable')),
    );
    const { router, queryClient } = await renderApp('/');
    await signOutFromMenu();
    await findToast('unavailable (test)');
    expect(router.state.location.pathname).toBe('/');
    expect(queryClient.getQueryData(['auth', 'me'])).toEqual(signedInUser);
  });

  it('goes to sign-in when the session was over already (401)', async () => {
    server.use(
      http.get('/v1/auth/me', () => HttpResponse.json(signedInUser)),
      http.post('/v1/auth/sign-out', () => problem(401, 'unauthorized')),
    );
    const { router, queryClient } = await renderApp('/');
    await signOutFromMenu();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sign-in'),
    );
    expect(queryClient.getQueryData(['auth', 'me'])).toBeNull();
  });
});
