import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NOTES_PATH } from '@/features/notes/api';
import {
  NOTE_ID,
  sampleNote,
  useNotesApi,
} from '@/features/notes/test/notes-api';
import { recordKeys } from '@/lib/records';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';

describe('watching a note', () => {
  it('watches and unwatches from the detail page', async () => {
    const { subscriptions } = useNotesApi({
      can: ['Note.read'],
      notes: [sampleNote()],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Watch' }));
    await findToast('You are watching this record.');
    expect(subscriptions.calls.watched).toEqual([NOTE_ID]);
    await user.click(
      await screen.findByRole('button', { name: 'Stop watching' }),
    );
    await findToast('You stopped watching.');
    expect(subscriptions.calls.unwatched).toEqual([NOTE_ID]);
  });

  it('reads whether the note is watched with the note, not from the subscriptions', async () => {
    const { calls, subscriptions } = useNotesApi({
      can: ['Note.read'],
      notes: [sampleNote()],
      watched: [NOTE_ID],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(
      await screen.findByRole('button', { name: 'Stop watching' }),
    ).toBeVisible();
    expect(calls.readQueries).toEqual(['?include=can%2Cwatching']);
    expect(subscriptions.calls.listed).toEqual([]);
  });

  it('keeps the note in the cache and says so, without reading it again', async () => {
    const { calls } = useNotesApi({
      can: ['Note.read'],
      notes: [sampleNote()],
    });
    const { queryClient } = await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Watch' }));
    await findToast('You are watching this record.');
    const cached = () =>
      queryClient.getQueryData<{ note: { watching?: boolean } }>(
        recordKeys.detail(NOTES_PATH, NOTE_ID),
      );
    await waitFor(() => expect(cached()?.note.watching).toBe(true));
    await user.click(
      await screen.findByRole('button', { name: 'Stop watching' }),
    );
    await findToast('You stopped watching.');
    await waitFor(() => expect(cached()?.note.watching).toBe(false));
    expect(calls.reads).toEqual([NOTE_ID]);
  });

  it('still sends the ETag of a note read with watching when it is edited', async () => {
    const { calls } = useNotesApi({
      can: ['Note.read', 'Note.update'],
      notes: [sampleNote()],
      watched: [NOTE_ID],
    });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toMatchObject({
      id: NOTE_ID,
      ifMatch: `"${NOTE_ID}-1-Q3 targets"`,
    });
    expect(calls.readQueries[0]).toContain('watching');
  });

  it('lists a watched note by its title, linked to its page', async () => {
    const { subscriptions } = useNotesApi({
      can: ['Note.read'],
      notes: [sampleNote()],
      watched: [NOTE_ID],
    });
    const { router } = await renderApp('/account/watching');
    const link = await screen.findByRole('link', { name: 'Q3 targets' });
    expect(link).toHaveAttribute('href', `/notes/${NOTE_ID}`);
    expect(screen.getByText(/^Note · since /)).toBeVisible();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Stop watching Q3 targets' }),
    );
    await findToast('You stopped watching.');
    expect(subscriptions.calls.removed).toEqual([`Note/${NOTE_ID}`]);
    expect(router.state.location.pathname).toBe('/account/watching');
  });
});
