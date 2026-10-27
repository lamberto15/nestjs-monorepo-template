import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleNote, useNotesApi } from '@/features/notes/test/notes-api';
import { bodiesOf, bulkHandlers, bulkResult } from '@/test/bulk-api';
import {
  choose,
  confirmDelete,
  expectNoBar,
  expectRunDone,
} from '@/test/bulk-steps';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

// The bulk actions are tested on a test-only list (features/bulk). Here, only
// that the notes list is wired to them: `pnpm feature:remove notes` takes
// these tests with the list.

const A = '0199a3f2-0000-7000-8000-000000000601';
const B = '0199a3f2-0000-7000-8000-000000000602';

function useNotesBulk(can: string[]) {
  const api = useNotesApi({
    can,
    notes: [
      sampleNote({ id: A, title: 'Old plan' }),
      sampleNote({ id: B, title: 'Older plan' }),
    ],
  });
  const { calls, handlers } = bulkHandlers({
    path: '/v1/notes',
    subject: 'Note',
    records: () => [...api.notes.values()],
    answer: { body: bulkResult(2, 0) },
  });
  server.use(...handlers);
  return calls;
}

describe('bulk actions on the notes list', () => {
  it('deletes the chosen notes with one request to /v1/notes/bulk', async () => {
    const calls = useNotesBulk(['Note.read', 'Note.delete']);
    await renderApp('/notes');
    const user = await choose('Old plan', 'Older plan');
    await confirmDelete(user, 'Delete 2 records?');
    await expectRunDone('Deleting');
    expect(bodiesOf(calls)).toEqual([{ action: 'delete', ids: [A, B] }]);
    await expectNoBar();
  });

  it('offers no selection without a bulk permission', async () => {
    useNotesBulk(['Note.read']);
    await renderApp('/notes');
    await screen.findByText('Old plan');
    expect(
      screen.queryByRole('checkbox', { name: 'Select row' }),
    ).not.toBeInTheDocument();
  });
});
