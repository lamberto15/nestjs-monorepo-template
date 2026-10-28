import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { tag, useTagsApi } from './test/tags-api';

const ADMIN = ['Access.manageTags'];

async function rowOf(name: string) {
  const table = await screen.findByRole('table');
  return within(table)
    .getAllByRole('row')
    .find((row) => within(row).queryByText(name))!;
}

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/tags');
    expect(entries({ 'Access.manageTags': true })).toContain('/tags');
  });

  it('sends a user without the permission away, with no request', async () => {
    const { calls } = useTagsApi({ can: ['TestItem.read'] });
    const { router } = await renderApp('/tags');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.reads).toEqual([]);
  });

  it('opens for whoever manages tags, from the menu', async () => {
    useTagsApi({ can: ADMIN });
    await renderApp('/');
    // Its group (Configuration) starts folded away from its pages.
    await userEvent.click(
      await screen.findByRole('button', { name: 'Configuration' }),
    );
    expect(await screen.findByRole('link', { name: 'Tags' })).toHaveAttribute(
      'href',
      '/tags',
    );
  });
});

describe('the list', () => {
  it('shows the tags of every subject, and filters them', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    const urgent = await rowOf('Urgent');
    expect(within(urgent).getByText('TestItem')).toBeVisible();
    expect(within(urgent).getByText('Needs an answer today')).toBeVisible();
    expect(await rowOf('Overdue')).toBeVisible();
    // No subject asked for: the management screen lists them all.
    expect(calls.reads[0]).toBeNull();

    await user.type(screen.getByLabelText('Search by name'), 'ov');
    expect(screen.queryByText('Urgent')).toBeNull();
    expect(screen.getByText('Overdue')).toBeVisible();
    await user.clear(screen.getByLabelText('Search by name'));

    await user.click(screen.getByRole('combobox', { name: 'Records' }));
    await user.click(await screen.findByRole('option', { name: 'Invoice' }));
    expect(screen.queryByText('Urgent')).toBeNull();
    expect(screen.getByText('Overdue')).toBeVisible();
  });

  it('says so when there are no tags', async () => {
    useTagsApi({ can: ADMIN, tags: [] });
    await renderApp('/tags');
    expect(await screen.findByText(/No tags yet/)).toBeVisible();
  });
});

describe('many tags', () => {
  const bulk = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      tag({
        id: `a${i}`,
        subject: 'Alpha',
        name: `a${String(i).padStart(4, '0')}`,
        color: null,
        description: null,
      }),
    );
  const beta = [1, 2, 3].map((n) =>
    tag({ id: `b${n}`, subject: 'Beta', name: `0-beta-${n}` }),
  );

  it('says when all subjects are cut at 1000, and reads a chosen subject on its own', async () => {
    const { calls } = useTagsApi({
      can: ADMIN,
      tags: [...bulk(1000), ...beta],
    });
    const user = userEvent.setup();
    await renderApp('/tags');
    expect(
      await screen.findByText(
        'Showing the first 1000 tags; filter by subject to see the rest.',
      ),
    ).toBeVisible();

    await user.click(screen.getByRole('combobox', { name: 'Records' }));
    await user.click(await screen.findByRole('option', { name: 'Beta' }));
    expect(await screen.findByText('0-beta-3')).toBeVisible();
    // Asked of the API by subject, not cut out of the first 1000.
    expect(calls.reads).toContain('Beta');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it('shows no notice under 1000 tags', async () => {
    useTagsApi({ can: ADMIN });
    await renderApp('/tags');
    await rowOf('Urgent');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });
});

describe('the subject filter', () => {
  it('goes back to all subjects when the chosen one has no tag left', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(await screen.findByRole('combobox', { name: 'Records' }));
    await user.click(await screen.findByRole('option', { name: 'Invoice' }));
    expect(screen.queryByText('Urgent')).toBeNull();
    await user.click(
      await screen.findByRole('button', { name: 'Delete Overdue' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete tag',
      }),
    );
    await waitFor(() => expect(calls.deleted).toEqual(['t3']));
    // Not an empty "Invoice" list: the filter is all again.
    expect(await rowOf('Urgent')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Records' })).toHaveTextContent(
      'All records',
    );
  });
});

describe('renaming', () => {
  it('sends the new name alone and shows it', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Critical');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({ id: 't1', body: { name: 'Critical' } });
    await findToast('Tag “Critical” saved.');
    expect(await rowOf('Critical')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a name another tag of the subject has on the field', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    // Whatever the case: the API compares them lowered.
    await user.type(name, 'q3');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'There is already a tag named “q3” for these records.',
      ),
    ).toBeVisible();
    expect(calls.patched).toHaveLength(1);
    // The dialog stays, with the input; a free name goes through.
    await user.clear(name);
    await user.type(name, 'Q4');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(2));
    expect(calls.patched[1]!.body).toEqual({ name: 'Q4' });
  });

  it('refuses an empty name without asking the API', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Give the tag a name.'),
    ).toBeVisible();
    expect(calls.patched).toEqual([]);
  });

  it('sends nothing when nothing changed', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.patched).toEqual([]);
  });
});

describe('recolouring', () => {
  it('sends the picked color', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Hex color value'), {
      target: { value: '#00ff00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({ id: 't1', body: { color: '#00ff00' } });
  });

  it('lets the hex be typed, and keeps it while it is partial', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    const hex = within(dialog).getByLabelText('Hex color value');
    await user.clear(hex);
    await user.type(hex, '#00f');
    // Partial: shown as typed, nothing committed yet.
    expect(hex).toHaveValue('#00f');
    await user.type(hex, 'f00');
    expect(hex).toHaveValue('#00ff00');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({ id: 't1', body: { color: '#00ff00' } });
  });

  it('expands a short hex when the field is left', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    const hex = within(dialog).getByLabelText('Hex color value');
    await user.clear(hex);
    await user.type(hex, '#0f0');
    await user.tab();
    expect(hex).toHaveValue('#00ff00');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({ id: 't1', body: { color: '#00ff00' } });
  });

  it('gives a tag without one a color', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(await screen.findByRole('button', { name: 'Edit Q3' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Choose a color' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({ id: 't2', body: { color: '#3b82f6' } });
  });

  it('takes the color off with null', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove the color' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({ id: 't1', body: { color: null } });
  });
});

describe('describing', () => {
  it('sends the new description, and null for an emptied one', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(await screen.findByRole('button', { name: 'Edit Q3' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Description'),
      'Third quarter',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({
      id: 't2',
      body: { description: 'Third quarter' },
    });
    expect(await screen.findByText('Third quarter')).toBeVisible();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Edit Q3' }));
    dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Description'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(2));
    expect(calls.patched[1]).toEqual({
      id: 't2',
      body: { description: null },
    });
  });
});

describe('deleting', () => {
  it('asks first, then deletes and drops the row', async () => {
    const { calls } = useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/tags');
    await user.click(
      await screen.findByRole('button', { name: 'Delete Urgent' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete the tag “Urgent”?')).toBeVisible();
    expect(
      within(dialog).getByText(
        /Every TestItem record carrying “Urgent” loses it/,
      ),
    ).toBeVisible();
    expect(calls.deleted).toEqual([]);
    // Cancelling deletes nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.deleted).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete Urgent' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete tag',
      }),
    );
    await waitFor(() => expect(calls.deleted).toEqual(['t1']));
    await findToast('Tag deleted.');
    await waitFor(() => expect(screen.queryByText('Urgent')).toBeNull());
  });
});

describe('what shows the tags is refreshed', () => {
  it('invalidates the subject tag lists and the records after a rename and a delete', async () => {
    useTagsApi({ can: ADMIN });
    const user = userEvent.setup();
    const { queryClient } = await renderApp('/tags');
    // What a record page holds: the subject's tags (the picker), a list page,
    // one record.
    queryClient.setQueryData(['tags', 'TestItem'], []);
    queryClient.setQueryData(['list', '/v1/test-items', {}], {});
    queryClient.setQueryData(['record', '/v1/test-items', 'i1'], {});
    const stale = () =>
      [
        ['tags', 'TestItem'],
        ['list', '/v1/test-items', {}],
        ['record', '/v1/test-items', 'i1'],
      ].map((key) => queryClient.getQueryState(key)!.isInvalidated);
    expect(stale()).toEqual([false, false, false]);

    await user.click(
      await screen.findByRole('button', { name: 'Edit Urgent' }),
    );
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Critical');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await findToast('Tag “Critical” saved.');
    expect(stale()).toEqual([true, true, true]);

    // Fresh again, then a delete.
    queryClient.setQueryData(['tags', 'TestItem'], []);
    queryClient.setQueryData(['list', '/v1/test-items', {}], {});
    queryClient.setQueryData(['record', '/v1/test-items', 'i1'], {});
    await user.click(
      await screen.findByRole('button', { name: 'Delete Critical' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete tag',
      }),
    );
    await findToast('Tag deleted.');
    expect(stale()).toEqual([true, true, true]);
  });
});
