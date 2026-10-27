import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meQuery } from '@/lib/session';
import { peopleHandler } from '@/test/people';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { problem, server, signedInUser } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

// The profile form stands for every guarded form (lib/unsaved-changes.ts):
// a core page, so the test outlives `pnpm feature:remove`.
// A reload or a closed tab (`enableBeforeUnload`) is the browser history's:
// the tests' memory history has no `beforeunload` to answer.

const QUESTION = 'You have unsaved changes. Leave this page and lose them?';

beforeEach(() => {
  useSignedIn([]);
  server.use(peopleHandler([]));
});

async function profile() {
  const rendered = await renderApp('/account/profile');
  const user = userEvent.setup();
  const name = await screen.findByRole('textbox', { name: 'Name' });
  return { ...rendered, user, name };
}

const answer = (leave: boolean) =>
  vi.spyOn(window, 'confirm').mockReturnValue(leave);

afterEach(() => vi.restoreAllMocks());

describe('leaving a form with unsaved input', () => {
  it('asks first, and stays when the user says so', async () => {
    const { router, user, name } = await profile();
    await user.type(name, ' B');

    const confirm = answer(false);
    // A blocked navigation never settles: it is started, not awaited.
    act(() => void router.navigate({ to: '/' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(QUESTION));
    expect(router.state.location.pathname).toBe('/account/profile');
    expect(name).toHaveValue(`${signedInUser.user.name} B`);

    confirm.mockReturnValue(true);
    await act(() => router.navigate({ to: '/' }));
    expect(router.state.location.pathname).toBe('/');
  });

  it('does not ask for an untouched form, nor for one changed back', async () => {
    const { router, user, name } = await profile();
    await user.type(name, ' B');
    await user.type(name, '{Backspace}{Backspace}');

    const confirm = answer(false);
    await act(() => router.navigate({ to: '/' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/');
  });

  it('does not ask once the input is saved', async () => {
    const { router, user, name } = await profile();
    server.use(
      http.patch('/v1/auth/me', async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json({ ...signedInUser.user, name: body.name });
      }),
    );
    await user.type(name, ' B');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await findToast('Profile saved.');

    const confirm = answer(false);
    await act(() => router.navigate({ to: '/' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/');
  });

  it('never holds the session-end redirect to sign-in', async () => {
    const { router, queryClient, user, name } = await profile();
    await user.type(name, ' B');
    const confirm = answer(false);

    // The session ended (idle limit, signed out elsewhere): the next read
    // of `me` says nobody, and the app goes to sign-in.
    server.use(http.get('/v1/auth/me', () => problem(401, 'unauthorized')));
    await act(() =>
      queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sign-in'),
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});
