import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { createSession } from '@/lib/session';
import { NOTE_ID, sampleNote, useNotesApi } from '@/test/notes-api';
import { renderApp } from '@/test/render-app';
import { server, signedInUser } from '@/test/server';

describe('a session reset', () => {
  it('refreshes what is mounted: the sidebar, the user menu, the page', async () => {
    const api = useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    const { queryClient, router } = await renderApp('/notes');
    expect(await screen.findByText('Acme')).toBeVisible();
    expect(
      await screen.findByRole('button', { name: /Ada Lovelace/ }),
    ).toBeVisible();
    await screen.findByText('Q3 targets');
    const listCalls = api.calls.listQueries.length;

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
          can: { 'Note.read': true },
        }),
      ),
    );
    await createSession(queryClient).reset();

    // No navigation, no remount: the same page, the new session's data.
    expect(router.state.location.pathname).toBe('/notes');
    expect(await screen.findByText('Globex')).toBeVisible();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeVisible();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.calls.listQueries.length).toBeGreaterThan(listCalls),
    );
  });

  it('drops the data of queries nobody has mounted, and the mutations', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    const { queryClient } = await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    queryClient.setQueryData(['orphan'], 'old tenant');
    await createSession(queryClient).reset();
    expect(queryClient.getQueryData(['orphan'])).toBeUndefined();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});
