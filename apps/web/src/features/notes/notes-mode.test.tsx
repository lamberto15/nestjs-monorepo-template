import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import {
  NOTE_ID,
  sampleNote,
  useNotesApi,
} from '@/features/notes/test/notes-api';
import { renderApp } from '@/test/render-app';
import { allFeatures, server } from '@/test/server';

// The write actions of the notes pages are off while the deployment is
// read-only (docs/settings.md, "Maintenance and read-only mode"): the
// reading stays, and the banner says why.

const ALL = [
  'Note.read',
  'Note.create',
  'Note.update',
  'Note.delete',
  'Note.restore',
];

/** Notes served as for an editor, with the deployment in `mode`. */
function useNotes(mode: 'normal' | 'read-only') {
  const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
  server.use(
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false, mode }),
    ),
  );
  return api;
}

describe('the notes list in read-only mode', () => {
  it('shows the notes, with New note off', async () => {
    useNotes('read-only');
    const { router } = await renderApp('/notes');
    expect(await screen.findByText('NOTE-2026-00001')).toBeVisible();
    expect(await screen.findByText(/read-only right now/)).toBeVisible();
    const create = screen.getByRole('button', { name: 'New note' });
    expect(create).toHaveAttribute('aria-disabled', 'true');
    await userEvent.setup().click(create);
    expect(router.state.location.pathname).toBe('/notes');
  });

  it("turns off a row's Edit and Delete, and leaves View", async () => {
    useNotes('read-only');
    const { router } = await renderApp('/notes');
    await screen.findByText(/read-only right now/);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Open actions/ }),
    );
    expect(await screen.findByRole('menuitem', { name: 'View' })).toBeEnabled();
    const edit = screen.getByRole('menuitem', { name: 'Edit note' });
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(edit).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    await user.click(edit);
    await user.click(remove);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(router.state.location.pathname).toBe('/notes');
  });

  it('has everything on in normal mode', async () => {
    useNotes('normal');
    await renderApp('/notes');
    await screen.findByText('NOTE-2026-00001');
    expect(
      screen.getByRole('button', { name: 'New note' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(/read-only right now/)).toBeNull();
  });
});

describe('a note in read-only mode', () => {
  it('turns off Edit, Delete and Watch', async () => {
    useNotes('read-only');
    const { router } = await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByText(/read-only right now/);
    expect(await screen.findByRole('button', { name: 'Watch' })).toBeDisabled();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for this note' }),
    );
    const edit = await screen.findByRole('menuitem', { name: 'Edit note' });
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(edit).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    await user.click(edit);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/notes/${NOTE_ID}`),
    );
  });

  it('turns off the form on the edit page', async () => {
    useNotes('read-only');
    await renderApp(`/notes/${NOTE_ID}/edit`);
    await screen.findByText(/read-only right now/);
    expect(
      await screen.findByRole('button', { name: 'Save changes' }),
    ).toBeDisabled();
  });
});
