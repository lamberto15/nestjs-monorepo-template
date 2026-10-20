import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { useNamingSeriesApi } from './test/naming-series-api';

const ADMIN = ['Access.manageNamingSeries'];

async function rowOf(text: string) {
  const table = await screen.findByRole('table');
  return within(table)
    .getAllByRole('row')
    .find((row) => within(row).queryByText(text))!;
}

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/naming-series');
    expect(entries({ 'Access.manageNamingSeries': true })).toContain(
      '/naming-series',
    );
  });

  it('sends a user without the permission away, with no request', async () => {
    const { calls } = useNamingSeriesApi({ can: ['Note.read'] });
    const { router } = await renderApp('/naming-series');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.reads).toEqual([]);
  });
});

describe('the list', () => {
  it('shows the series with their next number, and the subjects numbered by code', async () => {
    useNamingSeriesApi({ can: ADMIN });
    await renderApp('/naming-series');
    const notes = await rowOf('NOTE-.YYYY.-.#####');
    expect(within(notes).getByText('Default')).toBeVisible();
    expect(within(notes).getByText('NOTE-2026-00043')).toBeVisible();
    expect(
      within(await rowOf('MEMO-.YY.-.###')).getByText('Memos'),
    ).toBeVisible();
    // Invoice has no series: its format in code is shown.
    expect(await screen.findByText('INV-.YYYY.-.#####')).toBeVisible();
  });

  it('makes another series the default', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(
      await screen.findByRole('button', {
        name: 'Make MEMO-.YY.-.### the default',
      }),
    );
    await waitFor(() =>
      expect(calls.patched).toEqual([{ id: 's2', body: { isDefault: true } }]),
    );
    await findToast('“MEMO-.YY.-.###” is now the default.');
  });
});

describe('creating', () => {
  it('previews the next number as the pattern is typed, then creates', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(await screen.findByRole('button', { name: 'New series' }));
    const dialog = await screen.findByRole('dialog');
    const pattern = within(dialog).getByLabelText('Pattern');
    await user.type(pattern, 'Q.####');
    expect(
      await within(dialog).findByText('Next number: Q.00001'),
    ).toBeVisible();
    // The preview waits for the typing to rest: not a call for each key.
    expect(calls.previews.length).toBeLessThan(5);

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({ subject: 'Invoice', pattern: 'Q.####' });
    await findToast('Series “Q.####” created.');
    expect(await rowOf('Q.####')).toBeVisible();
  });

  it('shows the API’s message for an invalid pattern', async () => {
    useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(await screen.findByRole('button', { name: 'New series' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Pattern'), 'ABC');
    expect(
      await within(dialog).findByText(
        'The pattern needs one run of # for the counter.',
      ),
    ).toBeVisible();
  });

  it('shows a pattern the subject already has on the field', async () => {
    useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(await screen.findByRole('button', { name: 'New series' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Records' }));
    await user.click(await screen.findByRole('option', { name: 'Note' }));
    await user.type(within(dialog).getByLabelText('Pattern'), 'MEMO-.YY.-.###');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'Note already has a series with the pattern “MEMO-.YY.-.###”.',
      ),
    ).toBeVisible();
  });
});

describe('editing and deleting', () => {
  it('sends only the changed label', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(
      await screen.findByRole('button', { name: 'Edit MEMO-.YY.-.###' }),
    );
    const dialog = await screen.findByRole('dialog');
    const label = within(dialog).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Minutes');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.patched).toEqual([{ id: 's2', body: { label: 'Minutes' } }]),
    );
    expect(await screen.findByText('Minutes')).toBeVisible();
  });

  it('asks first, then deletes', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(
      await screen.findByRole('button', { name: 'Delete MEMO-.YY.-.###' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(calls.deleted).toEqual([]);
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete series' }),
    );
    await waitFor(() => expect(calls.deleted).toEqual(['s2']));
    await findToast('Series deleted.');
  });
});

describe('the counter', () => {
  it('shows the counter and the next number, and sets it', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(
      await screen.findByRole('button', {
        name: 'Counter of NOTE-.YYYY.-.#####',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('42')).toBeVisible();
    const input = within(dialog).getByLabelText('Continue from');
    await user.clear(input);
    await user.type(input, '100');
    await user.click(
      within(dialog).getByRole('button', { name: 'Set counter' }),
    );
    await waitFor(() =>
      expect(calls.counters).toEqual([{ id: 's1', body: { current: 100 } }]),
    );
    await findToast('Counter of “NOTE-.YYYY.-.#####” saved.');
  });

  it('says so when the value is below the last one taken (409)', async () => {
    useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(
      await screen.findByRole('button', {
        name: 'Counter of NOTE-.YYYY.-.#####',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    const input = await within(dialog).findByLabelText('Continue from');
    await user.clear(input);
    await user.type(input, '5');
    await user.click(
      within(dialog).getByRole('button', { name: 'Set counter' }),
    );
    expect(
      await within(dialog).findByText(
        'The counter cannot go below the last value taken (42).',
      ),
    ).toBeVisible();
  });
});
