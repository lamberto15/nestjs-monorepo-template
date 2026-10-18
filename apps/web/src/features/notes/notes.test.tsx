import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import openapi from '@nestjs-monorepo-template/api-client/openapi.json';
import { describe, expect, it } from 'vitest';
import { NOTE_LIMITS } from '@/features/notes/api';
import { renderApp } from '@/test/render-app';
import { NOTE_ID, sampleNote, useNotesApi } from '@/test/notes-api';
import { findToast } from '@/test/toast';

/** The request schemas of the API's routes, as the typed client's document has them. */
const schemaPaths = (
  openapi as unknown as {
    paths: Record<
      string,
      Record<
        string,
        {
          requestBody: {
            content: {
              'application/json': {
                schema: { properties: Record<string, { maxLength?: number }> };
              };
            };
          };
        }
      >
    >;
  }
).paths;

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
    expect(screen.getByText('Internal')).toBeVisible();
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
    expect(screen.getByText('Internal')).toBeVisible();
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

  // CI's template-without-notes job removes the API's notes: nothing to compare then.
  it.skipIf(!('/v1/notes' in schemaPaths))(
    "keeps its limits equal to the API schema's maxLength",
    () => {
      const schema = schemaPaths;
      for (const [path, method] of [
        ['/v1/notes', 'post'],
        ['/v1/notes/{id}', 'patch'],
      ] as const) {
        const { properties } =
          schema[path]![method]!.requestBody.content['application/json'].schema;
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

  it('says it was changed by someone else on a 412, and reloads on request', async () => {
    const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    const title = await screen.findByLabelText('Title');
    api.changeElsewhere(NOTE_ID, { title: 'Edited elsewhere' });
    await user.clear(title);
    await user.type(title, 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Someone else changed this note'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reload note' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Title')).toHaveValue('Edited elsewhere'),
    );
    expect(
      screen.queryByText('Someone else changed this note'),
    ).not.toBeInTheDocument();

    // The new version's ETag goes with the next save.
    await user.type(screen.getByLabelText('Title'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.patched).toHaveLength(2));
    expect(api.calls.patched[1]?.body).toEqual({ title: 'Edited elsewhere!' });
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
