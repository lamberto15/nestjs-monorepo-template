import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { series, useNamingSeriesApi } from './test/naming-series-api';

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

describe('rules', () => {
  it('lists the conditions, the priority and the date field of a series', async () => {
    useNamingSeriesApi({
      can: ADMIN,
      series: [
        series({
          id: 'v1',
          subject: 'Invoice',
          pattern: 'VIP-.#####',
          isDefault: false,
          conditions: [{ field: 'code', op: 'gte', value: 'vip' }],
          priority: 5,
          dateField: 'issuedOn',
        }),
      ],
    });
    await renderApp('/naming-series');
    const row = await rowOf('VIP-.#####');
    expect(within(row).getByText('code ≥ vip')).toBeVisible();
    expect(within(row).getByText('Priority 5')).toBeVisible();
    expect(within(row).getByText('Date from issuedOn')).toBeVisible();
  });

  it('lists the usable parts and adds one to the pattern on click', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(await screen.findByRole('button', { name: 'New series' }));
    const dialog = await screen.findByRole('dialog');
    // The variables come from the API; the subject (Invoice) has its fields.
    await user.click(
      await within(dialog).findByRole('button', {
        name: 'Add {FY} to the pattern',
      }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Add {code} to the pattern' }),
    );
    expect(within(dialog).getByLabelText('Pattern')).toHaveValue('{FY}.{code}');
    // A boolean field is not offered for the pattern.
    expect(
      within(dialog).queryByRole('button', {
        name: 'Add {paid} to the pattern',
      }),
    ).toBeNull();
    await waitFor(() => expect(calls.previews.length).toBeGreaterThan(0));
  });

  it('creates a series with a date field, conditions and a priority', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(await screen.findByRole('button', { name: 'New series' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Pattern'),
      'VIP-.{{code}.###',
    );

    await user.click(
      within(dialog).getByRole('combobox', { name: 'Date from' }),
    );
    await user.click(await screen.findByRole('option', { name: 'issuedOn' }));

    await user.click(
      within(dialog).getByRole('button', { name: 'Add condition' }),
    );
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Field of condition 1' }),
    );
    await user.click(await screen.findByRole('option', { name: 'total' }));
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Operator of condition 1' }),
    );
    await user.click(await screen.findByRole('option', { name: '≥' }));
    await user.type(
      within(dialog).getByLabelText('Value of condition 1'),
      '1000',
    );

    await user.click(
      within(dialog).getByRole('button', { name: 'Add condition' }),
    );
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Field of condition 2' }),
    );
    await user.click(await screen.findByRole('option', { name: 'paid' }));
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Value of condition 2' }),
    );
    await user.click(await screen.findByRole('option', { name: 'No' }));

    const priority = within(dialog).getByLabelText('Priority');
    await user.clear(priority);
    await user.type(priority, '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.created).toHaveLength(1));
    // Typed by the field's kind: a number, a boolean.
    expect(calls.created[0]).toEqual({
      subject: 'Invoice',
      pattern: 'VIP-.{code}.###',
      dateField: 'issuedOn',
      conditions: [
        { field: 'total', op: 'gte', value: 1000 },
        { field: 'paid', op: 'eq', value: false },
      ],
      priority: 5,
    });
  });

  it('removes a condition, and refuses an incomplete one', async () => {
    const { calls } = useNamingSeriesApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(await screen.findByRole('button', { name: 'New series' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Pattern'), 'Q.####');
    await user.click(
      within(dialog).getByRole('button', { name: 'Add condition' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Complete or remove every condition.'),
    ).toBeVisible();
    expect(calls.created).toEqual([]);
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove condition 1' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({ subject: 'Invoice', pattern: 'Q.####' });
  });

  it('changes the priority and clears the date field of a series', async () => {
    const { calls } = useNamingSeriesApi({
      can: ADMIN,
      series: [
        series({
          id: 'v1',
          subject: 'Invoice',
          pattern: 'VIP-.#####',
          conditions: [{ field: 'code', op: 'eq', value: 'vip' }],
          priority: 5,
          dateField: 'issuedOn',
        }),
      ],
    });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(
      await screen.findByRole('button', { name: 'Edit VIP-.#####' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Value of condition 1')).toHaveValue(
      'vip',
    );
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Date from' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'When created' }),
    );
    const priority = within(dialog).getByLabelText('Priority');
    await user.clear(priority);
    await user.type(priority, '9');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.patched).toEqual([
        { id: 'v1', body: { dateField: null, priority: 9 } },
      ]),
    );
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

  it('asks for the fields the pattern prints and sends their values', async () => {
    const { calls } = useNamingSeriesApi({
      can: ADMIN,
      series: [
        series({
          id: 'f1',
          subject: 'Invoice',
          pattern: 'SO-.{code}.-.###',
        }),
      ],
    });
    const user = userEvent.setup();
    await renderApp('/naming-series');
    await user.click(
      await screen.findByRole('button', {
        name: 'Counter of SO-.{code}.-.###',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    const code = await within(dialog).findByLabelText('Value of code');
    await user.type(code, 'acme');
    // The counter of that value is asked of the preview, with the values.
    await waitFor(() =>
      expect(calls.previews.at(-1)).toMatchObject({ values: { code: 'acme' } }),
    );
    expect(await within(dialog).findByText('SO-.acme.-.00001')).toBeVisible();
    const input = within(dialog).getByLabelText('Continue from');
    await user.clear(input);
    await user.type(input, '100');
    await user.click(
      within(dialog).getByRole('button', { name: 'Set counter' }),
    );
    await waitFor(() =>
      expect(calls.counters).toEqual([
        { id: 'f1', body: { current: 100, values: { code: 'acme' } } },
      ]),
    );
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
