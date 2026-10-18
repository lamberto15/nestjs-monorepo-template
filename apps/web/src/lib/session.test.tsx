import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { createSession } from '@/lib/session';
import { renderApp } from '@/test/render-app';
import { server, signedInUser } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

/** Signed in, on the notifications page (a page every project keeps). */
function useNotificationsPage() {
  useSignedIn([]);
  const calls = { list: 0 };
  server.use(
    http.get('/v1/notifications', () => {
      calls.list += 1;
      return HttpResponse.json({
        items: [
          {
            id: 'n1',
            type: 'comment.mentioned',
            title: 'Q3 targets',
            body: 'Maya mentioned you.',
            data: {},
            link: null,
            key: null,
            count: 1,
            read: false,
            readAt: null,
            createdAt: '2026-10-17T08:00:00.000Z',
            updatedAt: '2026-10-17T08:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    }),
  );
  return calls;
}

describe('a session reset', () => {
  it('refreshes what is mounted: the sidebar, the user menu, the page', async () => {
    const calls = useNotificationsPage();
    const { queryClient, router } = await renderApp('/notifications');
    expect(await screen.findByText('Acme')).toBeVisible();
    expect(
      await screen.findByRole('button', { name: /Ada Lovelace/ }),
    ).toBeVisible();
    await screen.findByText('Q3 targets');
    const listCalls = calls.list;

    // POST /v1/auth/tenant re-issues the session: the API now answers as
    // someone else in another tenant.
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          user: { ...signedInUser.user, name: 'Grace Hopper' },
          tenant: {
            id: signedInUser.tenant!.id,
            slug: 'globex',
            name: 'Globex',
          },
          can: {},
        }),
      ),
    );
    await createSession(queryClient).reset();

    // No navigation, no remount: the same page, the new session's data.
    expect(router.state.location.pathname).toBe('/notifications');
    expect(await screen.findByText('Globex')).toBeVisible();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeVisible();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    await waitFor(() => expect(calls.list).toBeGreaterThan(listCalls));
  });

  it('drops the data of queries nobody has mounted, and the mutations', async () => {
    useNotificationsPage();
    const { queryClient } = await renderApp('/notifications');
    await screen.findByText('Q3 targets');
    queryClient.setQueryData(['orphan'], 'old tenant');
    await createSession(queryClient).reset();
    expect(queryClient.getQueryData(['orphan'])).toBeUndefined();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});
