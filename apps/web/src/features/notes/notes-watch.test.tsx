import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  NOTE_ID,
  sampleNote,
  useNotesApi,
} from '@/features/notes/test/notes-api';
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
