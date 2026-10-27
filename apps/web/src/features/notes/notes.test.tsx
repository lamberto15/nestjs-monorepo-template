import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { NOTE_LIMITS } from '@/features/notes/api';
import { meQuery, sessionIdentity } from '@/lib/session';
import { readEditorDraft } from '@/lib/editor-drafts';
import { renderApp } from '@/test/render-app';
import { hasRoute, requestProperties } from '@/test/request-schemas';
import {
  NOTE_ID,
  sampleNote,
  useNotesApi,
} from '@/features/notes/test/notes-api';
import { problem, server, signedInUser } from '@/test/server';
import { expectNoToast, findToast } from '@/test/toast';

const ALL = [
  'Note.read',
  'Note.create',
  'Note.update',
  'Note.delete',
  'Note.restore',
];

describe('the note detail page', () => {
  it('shows the fields, with the status and tags as badges', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(
      await screen.findByRole('heading', { name: 'Q3 targets' }),
    ).toBeVisible();
    expect(screen.getByText('NOTE-2026-00001')).toBeVisible();
    expect(screen.getByText('Draft')).toBeVisible();
    // The tags panel, once the API said notes take tags.
    expect(await screen.findByText('Internal')).toBeVisible();
    expect(screen.getByText('Renewals first.')).toBeVisible();
  });

  it('shows no field the API left out for this user', async () => {
    const { body: _hidden, ...withoutBody } = sampleNote();
    useNotesApi({ can: ['Note.read'], notes: [withoutBody] });
    await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    expect(screen.queryByText('Text')).not.toBeInTheDocument();
  });

  it('shows a not-found state for a missing note', async () => {
    useNotesApi({ can: ALL, notes: [] });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(await screen.findByText('Note not found')).toBeVisible();
    // The page says it: not a toast as well.
    await expectNoToast();
  });

  it('offers edit and delete only with the permissions', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    expect(
      screen.queryByRole('button', { name: 'Actions for this note' }),
    ).not.toBeInTheDocument();
  });

  it("goes by the note's own can, not only the permissions", async () => {
    // An editor holds Note.update and Note.delete, but a published note's
    // conditions refuse both: no actions, and the panels are read-only.
    const api = useNotesApi({
      can: ALL,
      notes: [sampleNote({ status: 'published' })],
      recordCan: () => ({ update: false, delete: false }),
    });
    await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    expect(api.calls.reads.length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Actions for this note' }),
    ).not.toBeInTheDocument();
    // The tags panel, once the API said notes take tags.
    expect(await screen.findByText('Internal')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Edit tags' }),
    ).not.toBeInTheDocument();
  });

  it('offers delete without edit when only delete is allowed on the note', async () => {
    useNotesApi({
      can: ALL,
      notes: [sampleNote({ status: 'published' })],
      recordCan: () => ({ update: false }),
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for this note' }),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Delete' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Edit note' }),
    ).not.toBeInTheDocument();
  });

  it("shows no form on the edit page when the note's can refuses it", async () => {
    useNotesApi({
      can: ALL,
      notes: [sampleNote({ status: 'published' })],
      recordCan: () => ({ update: false }),
    });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    expect(
      await screen.findByText("You can't edit this note now"),
    ).toBeVisible();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(screen.getByText('Back to the note').closest('a')).toHaveAttribute(
      'href',
      `/notes/${NOTE_ID}`,
    );
  });

  it('sends a user who may not edit away from the edit page', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    const { router } = await renderApp(`/notes/${NOTE_ID}/edit`);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/notes/${NOTE_ID}`),
    );
  });
});

describe('creating a note', () => {
  it('validates before it sends anything', async () => {
    const api = useNotesApi({ can: ALL, notes: [] });
    await renderApp('/notes/new');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Create note' }),
    );
    expect(await screen.findByText('Enter a title.')).toBeVisible();
    expect(api.calls.created).toHaveLength(0);
  });

  it("puts the server's field errors on the fields", async () => {
    const api = useNotesApi({ can: ALL, notes: [] });
    await renderApp('/notes/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'Taken');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    expect(await screen.findByText('That title is taken')).toBeVisible();
    expect(api.calls.created).toHaveLength(1);
  });

  it('creates with an Idempotency-Key and opens the note', async () => {
    const api = useNotesApi({ can: ALL, notes: [] });
    const { router } = await renderApp('/notes/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'Hello');
    await user.type(screen.getByLabelText('Text'), 'World');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/notes\/.+/),
    );
    expect(api.calls.created[0]).toMatchObject({
      body: { title: 'Hello', body: 'World' },
      key: expect.stringMatching(/./),
    });
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeVisible();
  });

  it('sends nothing of a draft begun under another session, until the user says so', async () => {
    const api = useNotesApi({ can: ALL, notes: [] });
    const { queryClient } = await renderApp('/notes/new');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'Q3 for Globex');
    await user.type(screen.getByLabelText('Text'), 'Old tenant plans');

    // Another tab re-issued the shared cookie for another tenant: the
    // watcher here resets the caches, but the draft is component state and
    // survives — a submit must not send the old session's words under the
    // new one's cookie.
    const otherTenant = '0199a3f2-0000-7000-8000-00000000002a';
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          tenant: {
            ...signedInUser.tenant!,
            id: otherTenant,
            slug: 'globex',
            name: 'Globex',
          },
          can: Object.fromEntries(ALL.map((permission) => [permission, true])),
        }),
      ),
    );
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });

    // The draft is kept as it was written.
    expect(screen.getByLabelText('Title')).toHaveValue('Q3 for Globex');
    expect(screen.getByLabelText('Text')).toHaveValue('Old tenant plans');

    // The first submit warns and holds the draft; a second explicit submit
    // is required before the API request is sent under the new session.
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining('Nothing was sent'),
    );
    expect(api.calls.created).toHaveLength(0);
    expect(screen.getByLabelText('Title')).toHaveValue('Q3 for Globex');
    expect(screen.getByLabelText('Text')).toHaveValue('Old tenant plans');

    // The next submit is the user's own decision, under the new session.
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() => expect(api.calls.created).toHaveLength(1));
    expect(api.calls.created[0]).toMatchObject({
      body: { title: 'Q3 for Globex', body: 'Old tenant plans' },
    });
    alert.mockRestore();
  });

  it("shows the created note from the create's answer, and its ETag goes with the first edit", async () => {
    const api = useNotesApi({ can: ALL, notes: [] });
    const { router } = await renderApp('/notes/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeVisible();
    const id = router.state.location.pathname.split('/')[2]!;

    await user.click(
      screen.getByRole('button', { name: 'Actions for this note' }),
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Edit note' }),
    );
    const title = await screen.findByLabelText('Title');
    // Neither the detail page nor the edit form read the note again.
    expect(api.calls.reads).not.toContain(id);
    await user.type(title, '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.patched).toHaveLength(1));
    expect(api.calls.patched[0]).toMatchObject({
      id,
      body: { title: 'Hello!' },
      ifMatch: `"${id}-1-Hello"`,
    });
  });

  it("refuses a text longer than the API's limit before sending", async () => {
    const api = useNotesApi({ can: ALL, notes: [] });
    await renderApp('/notes/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'Long');
    await user.click(screen.getByLabelText('Text'));
    await user.paste('x'.repeat(NOTE_LIMITS.body + 1));
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    expect(
      await screen.findByText('The text is at most 10,000 characters.'),
    ).toBeVisible();
    expect(api.calls.created).toHaveLength(0);
  });

  // The other forms' limits are checked in lib/limits.test.ts; this feature
  // can be removed (CI's template-without-notes job), so its own stay here.
  it.skipIf(!hasRoute('/v1/notes'))(
    "keeps its limits equal to the API schema's maxLength",
    () => {
      for (const [path, method] of [
        ['/v1/notes', 'post'],
        ['/v1/notes/{id}', 'patch'],
      ] as const) {
        const properties = requestProperties(path, method);
        expect(properties.title?.maxLength).toBe(NOTE_LIMITS.title);
        expect(properties.body?.maxLength).toBe(NOTE_LIMITS.body);
      }
    },
  );
});

describe('editing a note', () => {
  it('sends only what changed, with the ETag as If-Match', async () => {
    const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'New title');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.patched).toHaveLength(1));
    expect(api.calls.patched[0]).toMatchObject({
      body: { title: 'New title' },
      ifMatch: expect.stringContaining(NOTE_ID),
    });
    expect(
      await screen.findByRole('heading', { name: 'New title' }),
    ).toBeVisible();
  });

  it('preserves a saved draft across navigation and requires explicit recovery or discard', async () => {
    localStorage.clear();
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    // Navigating away from the dirty form asks first (lib/unsaved-changes.ts);
    // this test is about the draft, not that guard, so it always says yes.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { router } = await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Recovered title');
    await user.clear(screen.getByLabelText('Text'));
    await user.type(screen.getByLabelText('Text'), 'Recovered text');
    const identity = sessionIdentity(signedInUser)!;
    await waitFor(() =>
      expect(
        readEditorDraft(identity, signedInUser.tenant!.id, NOTE_ID),
      ).toMatchObject({
        value: { title: 'Recovered title', body: 'Recovered text' },
      }),
    );

    await router.navigate({ to: '/notes/$id', params: { id: NOTE_ID } });
    await router.navigate({ to: '/notes/$id/edit', params: { id: NOTE_ID } });
    await user.click(
      await screen.findByRole('button', { name: 'Recover draft' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Title')).toHaveValue('Recovered title'),
    );
    expect(screen.getByLabelText('Text')).toHaveValue('Recovered text');

    await router.navigate({ to: '/notes/$id', params: { id: NOTE_ID } });
    await router.navigate({ to: '/notes/$id/edit', params: { id: NOTE_ID } });
    await user.click(
      await screen.findByRole('button', { name: 'Discard draft' }),
    );
    await waitFor(() =>
      expect(
        readEditorDraft(identity, signedInUser.tenant!.id, NOTE_ID),
      ).toBeUndefined(),
    );
    confirmSpy.mockRestore();
  });

  it('compares server and draft values, then reconciles with the latest ETag without losing concurrent edits', async () => {
    const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    await screen.findByLabelText('Title');
    api.changeElsewhere(NOTE_ID, { title: 'Edited elsewhere' });
    // The body control waits on notes.richText (use-rich-text.ts) before it
    // renders: findBy, not getBy, the first time this test reaches it.
    await user.clear(await screen.findByLabelText('Text'));
    await user.type(screen.getByLabelText('Text'), 'My text');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Someone else changed this note'),
    ).toBeVisible();
    expect(await screen.findByText('Edited elsewhere')).toBeVisible();
    expect(screen.getByText('Q3 targets')).toBeVisible();
    expect(screen.getByLabelText('Title')).toHaveValue('Q3 targets');
    expect(screen.getByLabelText('Text')).toHaveValue('My text');
    await user.click(
      screen.getByRole('button', { name: 'Save reconciled changes' }),
    );
    await waitFor(() => expect(api.calls.patched).toHaveLength(2));
    expect(api.calls.patched[1]?.body).toEqual({ body: 'My text' });
    expect(api.calls.patched[1]?.ifMatch).not.toBe(
      api.calls.patched[0]?.ifMatch,
    );
    expect(api.notes.get(NOTE_ID)?.title).toBe('Edited elsewhere');
  });

  it('refreshes the comparison after a second 412 and again uses a fresh ETag', async () => {
    const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Mine');
    api.changeElsewhere(NOTE_ID, { title: 'First concurrent value' });
    const tags: (string | null)[] = [];
    let attempts = 0;
    server.use(
      http.patch('/v1/notes/:id', async ({ request }) => {
        tags.push(request.headers.get('if-match'));
        attempts += 1;
        if (attempts === 1) return problem(412, 'precondition_failed');
        if (attempts === 2) {
          api.changeElsewhere(NOTE_ID, { body: 'Second concurrent value' });
          return problem(412, 'precondition_failed');
        }
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...api.notes.get(NOTE_ID)!, ...body });
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('First concurrent value');
    await user.click(
      screen.getByRole('button', { name: 'Save reconciled changes' }),
    );
    await screen.findByText('Second concurrent value');
    await user.click(
      screen.getByRole('button', { name: 'Save reconciled changes' }),
    );
    await waitFor(() => expect(tags).toHaveLength(3));
    expect(tags[0]).not.toBeNull();
    expect(tags[1]).not.toBe(tags[0]);
    expect(tags[2]).not.toBe(tags[1]);
  });

  it('does not restore a saved draft after the server revokes edit access', async () => {
    const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Mine');
    api.changeElsewhere(NOTE_ID, { title: 'Changed by another editor' });
    server.use(http.get('/v1/notes/:id', () => problem(403, 'forbidden')));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(
        'The latest note cannot be read or edited now. Your draft is kept; no changes were sent.',
      ),
    ).toBeVisible();
    expect(api.calls.patched).toHaveLength(1);
    expect(
      readEditorDraft(
        sessionIdentity(signedInUser)!,
        signedInUser.tenant!.id,
        NOTE_ID,
      ),
    ).toBeDefined();
  });
});

describe('deleting and restoring', () => {
  it('confirms, deletes, and the Undo of the toast restores', async () => {
    const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
    const { router } = await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for this note' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete this note?')).toBeVisible();
    expect(api.calls.deleted).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.calls.deleted).toEqual([NOTE_ID]));
    await waitFor(() => expect(router.state.location.pathname).toBe('/notes'));
    await findToast('Note deleted');

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.calls.restored).toEqual([NOTE_ID]));
    await findToast('Note restored');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/notes/${NOTE_ID}`),
    );
  });
});

describe('the list', () => {
  it('opens a note on a row click and offers a gated New note', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const { router } = await renderApp('/notes');
    const user = userEvent.setup();
    expect(
      await screen.findByRole('button', { name: 'New note' }),
    ).toBeVisible();
    const cell = await screen.findByText('NOTE-2026-00001');
    await user.click(cell);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/notes/${NOTE_ID}`),
    );
  });

  it("asks for each row's can and hides the actions a row refuses", async () => {
    const api = useNotesApi({
      can: ALL,
      notes: [sampleNote({ status: 'published' })],
      recordCan: () => ({ update: false, delete: false }),
    });
    await renderApp('/notes');
    const user = userEvent.setup();
    await screen.findByText('NOTE-2026-00001');
    expect(api.calls.listQueries.every((q) => q.includes('include=can'))).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: /Open actions/ }));
    expect(await screen.findByRole('menuitem', { name: 'View' })).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Edit note' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Delete' }),
    ).not.toBeInTheDocument();
  });

  it('hides New note and the bin without the permissions', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    await renderApp('/notes');
    await screen.findByText('NOTE-2026-00001');
    expect(screen.queryByRole('button', { name: 'New note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recycle bin' })).toBeNull();
  });

  it('shows the recycle bin with ?deleted=true and restores from it', async () => {
    const api = useNotesApi({
      can: ALL,
      notes: [
        sampleNote({ deletedAt: '2026-10-17T10:00:00.000Z', title: 'Gone' }),
      ],
    });
    await renderApp('/notes');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Recycle bin' }),
    );
    expect(await screen.findByText('Gone')).toBeVisible();
    expect(api.calls.listQueries.some((q) => q.includes('deleted=true'))).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: /Open actions/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => expect(api.calls.restored).toEqual([NOTE_ID]));
    await findToast('Note restored');
  });

  it('offers no Restore for a binned row whose can refuses it', async () => {
    useNotesApi({
      can: ALL,
      notes: [
        sampleNote({ deletedAt: '2026-10-17T10:00:00.000Z', title: 'Gone' }),
      ],
      recordCan: () => ({ restore: false }),
    });
    await renderApp('/notes?deleted=true');
    const user = userEvent.setup();
    expect(await screen.findByText('Gone')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Open actions/ }));
    expect(await screen.findByRole('menuitem', { name: 'View' })).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Restore' }),
    ).not.toBeInTheDocument();
  });
});
