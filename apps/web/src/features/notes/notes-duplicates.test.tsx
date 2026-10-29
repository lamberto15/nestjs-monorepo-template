import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import {
  NOTE_ID,
  sampleNote,
  useNotesApi,
} from '@/features/notes/test/notes-api';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

const ALL = ['Note.read', 'Note.create', 'Note.update', 'Note.delete'];
const OTHER = '0199a3f2-0000-7000-8000-000000000599';
const likely = {
  id: OTHER,
  matched: [['title']],
  record: { id: OTHER, title: 'Weekly sync' },
};

describe('duplicate notes', () => {
  it('warns of likely duplicates while the form is filled in, and still saves', async () => {
    const api = useNotesApi({ can: ALL, notes: [], duplicates: [likely] });
    const { router } = await renderApp('/notes/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'weekly sync');
    const warning = (
      await screen.findByText('This may already exist:')
    ).closest('[role="status"]') as HTMLElement;
    expect(
      within(warning).getByRole('link', { name: 'Weekly sync' }),
    ).toHaveAttribute('href', `/notes/${OTHER}`);
    expect(api.calls.duplicateChecks.at(-1)).toEqual({
      values: { title: 'weekly sync' },
    });
    // A hint, not a block.
    await user.type(screen.getByLabelText('Text'), 'Agenda');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/notes\/.+/),
    );
    expect(api.calls.created).toHaveLength(1);
  });

  it('leaves the note being edited out of the check', async () => {
    const api = useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    await screen.findByLabelText('Title');
    await waitFor(() =>
      expect(api.calls.duplicateChecks.at(-1)).toMatchObject({
        excludeId: NOTE_ID,
      }),
    );
    expect(screen.queryByText(/This may already exist/)).toBeNull();
  });

  it("shows the note's duplicates on its page", async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    server.use(
      http.get(`/v1/notes/${NOTE_ID}/duplicates`, () =>
        HttpResponse.json({ items: [likely] }),
      ),
    );
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Duplicates' }));
    expect(await screen.findByText('Weekly sync')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Merge into this record' }),
    ).toBeVisible();
  });
});
