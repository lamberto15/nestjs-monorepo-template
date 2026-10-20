import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { series } from '@/features/naming-series/test/naming-series-api';
import { useNotesApi } from '@/features/notes/test/notes-api';
import { renderApp } from '@/test/render-app';

const CAN = ['Note.read', 'Note.create', 'Note.update'];
const SERIES = [
  series(),
  series({ id: 's2', pattern: 'MEMO-.###', label: 'Memos', isDefault: false }),
];

describe('the numbering picker of the note form', () => {
  it.each([
    ['no series', []],
    ['one series', [series()]],
  ])('is not shown with %s', async (_name, namingSeries) => {
    const api = useNotesApi({ can: CAN, notes: [], namingSeries });
    const user = userEvent.setup();
    await renderApp('/notes/new');
    await user.type(await screen.findByLabelText('Title'), 'Hello');
    expect(screen.queryByText('Numbering')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() => expect(api.calls.created).toHaveLength(1));
    expect(api.calls.created[0]!.body).not.toHaveProperty('namingSeriesId');
  });

  it('is shown with two, the default preselected, and its choice is sent', async () => {
    const api = useNotesApi({ can: CAN, notes: [], namingSeries: SERIES });
    const user = userEvent.setup();
    await renderApp('/notes/new');
    const picker = await screen.findByRole('combobox', { name: 'Numbering' });
    expect(picker).toHaveTextContent('Notes (NOTE-2026-00043)');
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: /Memos/ }));
    await user.type(screen.getByLabelText('Title'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() => expect(api.calls.created).toHaveLength(1));
    expect(api.calls.created[0]!.body).toMatchObject({
      title: 'Hello',
      namingSeriesId: 's2',
    });
  });

  it('sends the default series when the user does not choose', async () => {
    const api = useNotesApi({ can: CAN, notes: [], namingSeries: SERIES });
    const user = userEvent.setup();
    await renderApp('/notes/new');
    await user.type(await screen.findByLabelText('Title'), 'Hello');
    await within(document.body).findByRole('combobox', { name: 'Numbering' });
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() => expect(api.calls.created).toHaveLength(1));
    expect(api.calls.created[0]!.body).toMatchObject({ namingSeriesId: 's1' });
  });
});
