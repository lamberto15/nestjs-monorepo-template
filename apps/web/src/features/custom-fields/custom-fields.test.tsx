import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw/http';
import { describe, expect, it } from 'vitest';

import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { problem, server } from '@/test/server';
import { findToast } from '@/test/toast';
import {
  changesBody,
  createBody,
  toValues,
  EMPTY_DEFINITION,
} from './definition';
import { AMOUNT, field, useCustomFieldsApi } from './test/custom-fields-api';

const ADMIN = ['Access.manageCustomFields', 'TestItem.read'];

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const names = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(names({})).not.toContain('/custom-fields');
    expect(names({ 'Access.manageCustomFields': true })).toContain(
      '/custom-fields',
    );
  });

  it('sends a user without the permission away from the route', async () => {
    useCustomFieldsApi({ can: ['TestItem.read'], fields: [] });
    const { router } = await renderApp('/custom-fields');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

describe('the definitions list', () => {
  it('shows the active fields in order and the deactivated ones apart', async () => {
    const old = field({
      id: '0199a3f2-0000-7000-8000-000000000a09',
      key: 'old',
      label: 'Legacy',
      active: false,
      position: 2,
    });
    useCustomFieldsApi({ can: ADMIN, fields: [field(), AMOUNT, old] });
    await renderApp('/custom-fields');
    const active = await screen.findByRole('list', { name: /Active fields/ });
    const rows = within(active).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Region'),
      expect.stringContaining('Amount'),
    ]);
    expect(within(rows[0]!).getByText('Choice')).toBeVisible();
    expect(within(rows[0]!).getByText('Filterable')).toBeVisible();
    expect(screen.getByText('Deactivated fields (1)')).toBeVisible();
    expect(screen.getByText('Legacy')).toBeVisible();
  });
});

describe('the subjects', () => {
  const NOTE = {
    subject: 'Note',
    label: { singular: 'Note', plural: 'Notes' },
  };
  const ITEM = {
    subject: 'TestItem',
    label: { singular: 'Test item', plural: 'Test items' },
  };

  it("offers the API's subjects under the names it sends", async () => {
    const { calls } = useCustomFieldsApi({
      can: ADMIN,
      fields: [field()],
      subjects: [ITEM, NOTE],
    });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    const select = await screen.findByRole('combobox', { name: 'Records' });
    // The first subject is shown, by its plural name, not by its key.
    await waitFor(() => expect(select).toHaveTextContent('Test items'));
    expect(await screen.findByText('Region')).toBeVisible();
    await user.click(select);
    expect(await screen.findByRole('option', { name: 'Notes' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Test items' })).toBeVisible();
    expect(calls.reads[0]).toContain('subject=TestItem');
  });

  it('shows a skeleton while the subjects load', async () => {
    useCustomFieldsApi({ can: ADMIN, fields: [] });
    server.use(
      http.get('/v1/custom-fields/subjects', () => new Promise(() => {})),
    );
    await renderApp('/custom-fields');
    expect(await screen.findByRole('generic', { busy: true })).toBeVisible();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says so when the subjects cannot be loaded', async () => {
    useCustomFieldsApi({ can: ADMIN, fields: [] });
    server.use(
      http.get('/v1/custom-fields/subjects', () => problem(500, 'internal')),
    );
    await renderApp('/custom-fields');
    expect(await screen.findByRole('alert')).toHaveTextContent('internal');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says so when no subject takes custom fields', async () => {
    useCustomFieldsApi({ can: ADMIN, fields: [], subjects: [] });
    await renderApp('/custom-fields');
    expect(
      await screen.findByText('No records take custom fields yet.'),
    ).toBeVisible();
  });
});

describe('creating a field', () => {
  it('sends a text field with its limits and a pattern', async () => {
    const { calls } = useCustomFieldsApi({ can: ADMIN, fields: [] });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Add a field' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Key'), 'code');
    await user.type(within(dialog).getByLabelText('Label'), 'Code');
    await user.type(within(dialog).getByLabelText('Shortest length'), '3');
    await user.type(within(dialog).getByLabelText('Longest length'), '8');
    await user.type(within(dialog).getByLabelText('Pattern'), '[[A-Z]+');
    await user.type(within(dialog).getByLabelText('Default value'), 'ABC');
    await user.click(within(dialog).getByRole('switch', { name: 'Required' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({
      subject: 'TestItem',
      key: 'code',
      label: 'Code',
      type: 'text',
      required: true,
      filterable: false,
      sortable: false,
      default: 'ABC',
      validation: { minLength: 3, maxLength: 8, pattern: '[A-Z]+' },
    });
    // The new field shows in the list.
    expect(await screen.findByText('code')).toBeVisible();
  });

  it('sends a select with its choices and a default among them', async () => {
    const { calls } = useCustomFieldsApi({ can: ADMIN, fields: [] });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Add a field' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Key'), 'region');
    await user.type(within(dialog).getByLabelText('Label'), 'Region');
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Choice' }));
    await user.click(
      await within(dialog).findByRole('button', { name: 'Add a choice' }),
    );
    await user.type(within(dialog).getByLabelText('Value of choice 1'), 'eu');
    await user.type(
      within(dialog).getByLabelText('Label of choice 1'),
      'Europe',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Add a choice' }),
    );
    await user.type(within(dialog).getByLabelText('Value of choice 2'), 'us');
    await user.type(
      within(dialog).getByLabelText('Label of choice 2'),
      'Americas',
    );
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Default value' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Europe' }));
    await user.click(
      within(dialog).getByRole('switch', { name: 'Filterable' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({
      subject: 'TestItem',
      key: 'region',
      label: 'Region',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'Americas' },
      ],
      required: false,
      filterable: true,
      sortable: false,
      default: 'eu',
    });
  });

  it('refuses a bad key, and choices that are missing or repeated, before sending', async () => {
    const { calls } = useCustomFieldsApi({ can: ADMIN, fields: [] });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Add a field' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Key'), 'Bad Key');
    await user.type(within(dialog).getByLabelText('Label'), 'Pick');
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(
      await screen.findByRole('option', { name: 'Multiple choice' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add field' }));
    expect(
      await within(dialog).findByText(/Start with a lowercase letter/),
    ).toBeVisible();
    expect(within(dialog).getByText('Add at least one choice.')).toBeVisible();
    expect(calls.created).toHaveLength(0);
  });

  it('shows the API problem in the dialog, which stays open', async () => {
    const { calls, fail } = useCustomFieldsApi({ can: ADMIN, fields: [] });
    fail.next = problem(409, 'custom_field_exists', {
      detail: 'The key “code” is already used.',
    });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Add a field' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Key'), 'code');
    await user.type(within(dialog).getByLabelText('Label'), 'Code');
    await user.click(within(dialog).getByRole('button', { name: 'Add field' }));
    expect(
      await within(dialog).findByText('The key “code” is already used.'),
    ).toBeVisible();
    expect(calls.created).toHaveLength(1);
  });
});

describe('editing a field', () => {
  it('sends only what changed, and not the key', async () => {
    const { calls } = useCustomFieldsApi({ can: ADMIN, fields: [AMOUNT] });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Amount' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Key')).not.toBeInTheDocument();
    const label = within(dialog).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Total');
    const max = within(dialog).getByLabelText('Highest value');
    await user.clear(max);
    await user.type(max, '500');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({
      id: AMOUNT.id,
      body: { label: 'Total', validation: { min: 0, max: 500 } },
    });
  });

  it('sends nothing when nothing changed', async () => {
    const { calls } = useCustomFieldsApi({ can: ADMIN, fields: [AMOUNT] });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Amount' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.patched).toHaveLength(0);
  });

  it('refuses a lowest value above the highest', async () => {
    const { calls } = useCustomFieldsApi({ can: ADMIN, fields: [AMOUNT] });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Amount' }),
    );
    const dialog = await screen.findByRole('dialog');
    const min = within(dialog).getByLabelText('Lowest value');
    await user.clear(min);
    await user.type(min, '200');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'The lowest must not exceed the highest.',
      ),
    ).toBeVisible();
    expect(calls.patched).toHaveLength(0);
  });
});

describe('the bodies', () => {
  const base = { ...EMPTY_DEFINITION, key: 'k', label: ' K ' };

  it.each([
    ['text', {}, {}],
    ['longText', {}, {}],
    ['email', {}, {}],
    ['url', {}, {}],
    ['date', { default: '2026-01-05' }, { default: '2026-01-05' }],
    ['boolean', { default: true }, { default: true }],
    [
      'number',
      { min: '1', max: '9', default: '5' },
      { validation: { min: 1, max: 9 }, default: 5 },
    ],
    [
      'multiSelect',
      {
        options: [{ value: 'a', label: 'A' }],
        min: '1',
        default: ['a'],
      },
      {
        options: [{ value: 'a', label: 'A' }],
        validation: { min: 1 },
        default: ['a'],
      },
    ],
  ] as const)(
    'creates a %s field with only what its type takes',
    (type, over, expected) => {
      expect(
        createBody('TestItem', {
          ...base,
          type,
          // Limits of other types are ignored.
          pattern: type === 'number' ? 'ignored' : '',
          ...(over as object),
        }),
      ).toEqual({
        subject: 'TestItem',
        key: 'k',
        label: 'K',
        type,
        required: false,
        filterable: false,
        sortable: false,
        ...expected,
      });
    },
  );

  it('clears what the new type does not take', () => {
    const select = field({ default: 'eu', validation: null });
    const values = {
      ...toValues(select),
      type: 'text' as const,
      default: undefined,
    };
    expect(changesBody(select, values)).toEqual({
      type: 'text',
      options: null,
      default: null,
    });
  });
});

describe('ordering, deactivating and reactivating', () => {
  it('sends the new order when a field is moved', async () => {
    const { calls } = useCustomFieldsApi({
      can: ADMIN,
      fields: [field(), AMOUNT],
    });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    const first = await screen.findByRole('button', {
      name: 'Move Region down',
    });
    expect(
      screen.getByRole('button', { name: 'Move Region up' }),
    ).toBeDisabled();
    await user.click(first);
    await waitFor(() => expect(calls.reordered).toHaveLength(1));
    expect(calls.reordered[0]).toEqual({
      subject: 'TestItem',
      ids: [AMOUNT.id, field().id],
    });
    // The list follows it.
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('list', { name: /Active fields/ }),
        ).getAllByRole('listitem')[0]?.textContent,
      ).toContain('Amount'),
    );
  });

  it('offers a handle to drag or to move with the keyboard', async () => {
    useCustomFieldsApi({ can: ADMIN, fields: [field(), AMOUNT] });
    await renderApp('/custom-fields');
    const handle = await screen.findByRole('button', {
      name: 'Reorder Region',
    });
    // dnd-kit's keyboard sensor: a button with its instructions.
    expect(handle).toHaveAttribute('aria-roledescription', 'sortable');
  });

  it('deactivates after a confirmation that says the values are kept, then brings it back', async () => {
    const { calls } = useCustomFieldsApi({ can: ADMIN, fields: [field()] });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Deactivate Region' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/values records already hold are kept/),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole('button', { name: 'Deactivate' }),
    );
    await waitFor(() => expect(calls.deactivated).toEqual([field().id]));
    await user.click(
      await screen.findByRole('button', { name: 'Reactivate Region' }),
    );
    await waitFor(() =>
      expect(calls.patched).toEqual([
        { id: field().id, body: { active: true } },
      ]),
    );
    expect(await findToast('Field reactivated.')).toBeVisible();
  });

  it('says why a field cannot be brought back', async () => {
    const { fail } = useCustomFieldsApi({
      can: ADMIN,
      fields: [field({ active: false })],
    });
    fail.next = problem(409, 'custom_field_limit', {
      detail: 'The subject already has 100 active custom fields.',
    });
    const user = userEvent.setup();
    await renderApp('/custom-fields');
    await user.click(
      await screen.findByRole('button', { name: 'Reactivate Region' }),
    );
    expect(
      await findToast('The subject already has 100 active custom fields.'),
    ).toBeVisible();
  });
});
