import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { ListPage, type ListPageProps } from '@/components/list-page';
import type { ListColumn, ListPath } from '@/lib/list-query';
import { renderComponent } from '@/test/render-component';
import { findToast } from '@/test/toast';
import { TEST_ITEMS, useViewsApi, view } from './test/views-api';

// ListPage on a test-only subject (as the API's tests use TestItem), not a
// feature's page: these tests stand when `pnpm feature:remove` takes a feature.
const TestListPage = ListPage as unknown as (
  props: Omit<ListPageProps<ListPath>, 'path' | 'columns'> & {
    path: string;
    columns: ListColumn<ItemRow>[];
  },
) => ReactNode;
type ItemRow = { id: string; number: string; title: string; status: string };

const columns: ListColumn<ItemRow>[] = (
  [
    ['number', 'Number'],
    ['title', 'Title'],
    ['status', 'Status'],
  ] as const
).map(([id, header]) => ({
  id,
  accessorKey: id,
  header,
  meta: { label: header },
}));

function renderList(searchParams = '', can: readonly string[] = []) {
  return renderComponent(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory>
      <TestListPage
        subject="TestItem"
        path={TEST_ITEMS}
        title="Test items"
        columns={columns}
      />
    </NuqsTestingAdapter>,
    { can },
  );
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    await screen.findByRole('button', { name: /^(Views|Current view)/ }),
  );
};

const lastList = (lists: string[]) => new URLSearchParams(lists.at(-1));

describe('choosing a view', () => {
  it('lists the views the API shows, grouped by who sees them', async () => {
    const { calls } = useViewsApi({
      views: [
        view(),
        view({ id: 'v2', name: 'Team backlog', visibility: 'team' }),
        view({
          id: 'v3',
          name: 'Everything open',
          visibility: 'tenant',
          mine: false,
          editable: false,
        }),
      ],
    });
    const user = userEvent.setup();
    await renderList();
    // Read when the menu opens, not before, and for this list only.
    expect(calls.reads).toEqual([]);
    await open(user);
    expect(
      await screen.findByRole('menuitem', { name: 'Drafts' }),
    ).toBeVisible();
    expect(screen.getByText('Mine')).toBeVisible();
    expect(screen.getByText('My teams')).toBeVisible();
    expect(screen.getByText('Everyone')).toBeVisible();
    expect(
      screen.getByRole('menuitem', { name: 'Team backlog' }),
    ).toBeVisible();
    expect(new URLSearchParams(calls.reads[0]).get('subject')).toBe('TestItem');
  });

  it("applies a view's sort, search and columns to the table", async () => {
    const { calls } = useViewsApi({
      views: [
        view({
          query: { sort: '-title', q: 'targets' },
          columns: ['title', 'status'],
        }),
      ],
    });
    const user = userEvent.setup();
    await renderList();
    expect(await screen.findByText('Q3 targets')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: /Number/ })).toBeVisible();

    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));

    expect(await findToast('View “Drafts” applied.')).toBeVisible();
    expect(calls.applied).toEqual(['v1']);
    await waitFor(() => {
      const query = lastList(calls.lists);
      expect(query.get('q')).toBe('targets');
      expect(query.get('sort')).toBe('-title');
      expect(query.get('fields')).toBe('title,status');
    });
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue(
      'targets',
    );
    expect(screen.queryByRole('columnheader', { name: /Number/ })).toBeNull();
    // The picker names the view in use.
    expect(
      screen.getByRole('button', { name: 'Current view: Drafts' }),
    ).toBeVisible();
  });

  it("applies a view's filter, JSON and flat, to the table", async () => {
    const { calls } = useViewsApi({
      views: [
        view({
          query: {
            filter: JSON.stringify({
              and: [
                { field: 'status', op: 'in', value: ['draft', 'published'] },
              ],
            }),
            title: 'Q3',
          },
        }),
      ],
    });
    const user = userEvent.setup();
    await renderList();
    await screen.findByText('Q3 targets');
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));

    await waitFor(() => {
      const filter = JSON.parse(
        lastList(calls.lists).get('filter') ?? '{"and":[]}',
      ) as { and: unknown[] };
      // In the table's column order, whatever the view's.
      expect(filter.and).toHaveLength(2);
      expect(filter.and).toEqual(
        expect.arrayContaining([
          { field: 'status', op: 'in', value: ['draft', 'published'] },
          { field: 'title', op: 'eq', value: 'Q3' },
        ]),
      );
    });
  });

  it('says a view is out of date on a 400, and leaves the table as it is', async () => {
    const { calls } = useViewsApi({ views: [{ ...view(), stale: true }] });
    const user = userEvent.setup();
    await renderList();
    await screen.findByText('Q3 targets');
    const before = calls.lists.length;
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));
    expect(
      await findToast(/“Drafts” is out of date\. query\.custom\.region is not/),
    ).toBeVisible();
    expect(calls.lists.length).toBe(before);
    expect(screen.getByRole('button', { name: 'Views' })).toBeVisible();
  });

  it('says why on a 403 field_forbidden', async () => {
    useViewsApi({ views: [{ ...view(), forbidden: true }] });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));
    expect(
      await findToast(
        '“Drafts” cannot be applied. You may not filter by this field.',
      ),
    ).toBeVisible();
  });

  it('refuses a filter the table has no control for', async () => {
    useViewsApi({
      views: [view({ query: { 'nope.contains': 'x' } })],
    });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));
    expect(
      await findToast(/uses a filter this table cannot show/),
    ).toBeVisible();
  });
});

describe('saving the current view', () => {
  it('sends the filter, sort, search and columns as shown', async () => {
    const { calls } = useViewsApi({ views: [] });
    const user = userEvent.setup();
    await renderList('?status=draft&sort=title.asc&q=hello');
    await screen.findByText('Q3 targets');
    await open(user);
    expect(await screen.findByText('No saved views yet.')).toBeVisible();
    await user.click(
      screen.getByRole('menuitem', { name: 'Save the current view…' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), '  My drafts ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await findToast('View “My drafts” saved.')).toBeVisible();
    const body = calls.created[0] as {
      query: Record<string, string>;
      columns: string[];
      [key: string]: unknown;
    };
    expect(body).toMatchObject({
      subject: 'TestItem',
      name: 'My drafts',
      visibility: 'private',
    });
    expect(JSON.parse(body.query.filter ?? 'null')).toEqual({
      and: [{ field: 'status', op: 'in', value: ['draft'] }],
    });
    expect(body.query.sort).toBe('title');
    expect(body.query.q).toBe('hello');
    expect(body.columns).toEqual(expect.arrayContaining(['title', 'status']));
    // Paging and the route's own parameters are not part of a view.
    expect(Object.keys(body.query).toSorted()).toEqual(['filter', 'q', 'sort']);
    expect(
      await screen.findByRole('button', { name: 'Current view: My drafts' }),
    ).toBeVisible();
  });

  it('puts a taken name on the name field, and other refusals in the dialog', async () => {
    useViewsApi({ views: [] });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(
      await screen.findByRole('menuitem', { name: 'Save the current view…' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Taken');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'A view called “Taken” already exists here.',
      ),
    ).toBeVisible();

    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Forbidden');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('field_forbidden (test)'),
    ).toBeVisible();
  });

  it('asks for a name before it sends anything', async () => {
    const { calls } = useViewsApi({ views: [] });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(
      await screen.findByRole('menuitem', { name: 'Save the current view…' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeVisible();
    expect(calls.created).toEqual([]);
  });

  it('shares with a team, and with the tenant only for a view manager', async () => {
    const { calls } = useViewsApi({ views: [] });
    const user = userEvent.setup();
    await renderList('', ['Access.manageViews']);
    await open(user);
    await user.click(
      await screen.findByRole('menuitem', { name: 'Save the current view…' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Sales view');
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Who sees it' }),
    );
    expect(
      await screen.findByRole('option', {
        name: 'Everyone in the organization',
      }),
    ).toBeVisible();
    await user.click(screen.getByRole('option', { name: 'A team' }));
    await user.click(
      await within(dialog).findByRole('combobox', { name: 'Team' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Sales' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await findToast('View “Sales view” saved.');
    expect(calls.created[0]).toMatchObject({
      visibility: 'team',
      teamId: 'team-1',
    });
  });

  it('offers the tenant only to a view manager', async () => {
    useViewsApi({ views: [] });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(
      await screen.findByRole('menuitem', { name: 'Save the current view…' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Who sees it' }),
    );
    expect(await screen.findByRole('option', { name: 'A team' })).toBeVisible();
    expect(
      screen.queryByRole('option', { name: 'Everyone in the organization' }),
    ).toBeNull();
  });
});

describe('renaming and deleting', () => {
  it('renames and deletes the chosen view', async () => {
    const { calls } = useViewsApi({ views: [view()] });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));
    await findToast('View “Drafts” applied.');

    await open(user);
    await user.click(
      await screen.findByRole('menuitem', { name: 'Rename “Drafts”…' }),
    );
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('Drafts');
    await user.clear(name);
    await user.type(name, 'Open drafts');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await findToast('View renamed to “Open drafts”.')).toBeVisible();
    expect(calls.patched).toEqual([
      { id: 'v1', body: { name: 'Open drafts' } },
    ]);

    await open(user);
    await user.click(
      await screen.findByRole('menuitem', { name: 'Delete “Open drafts”…' }),
    );
    const confirm = await screen.findByRole('alertdialog');
    await user.click(
      within(confirm).getByRole('button', { name: 'Delete view' }),
    );
    expect(await findToast('View deleted.')).toBeVisible();
    expect(calls.deleted).toEqual(['v1']);
    expect(await screen.findByRole('button', { name: 'Views' })).toBeVisible();
  });

  it('shows a taken name on a rename', async () => {
    useViewsApi({ views: [view()] });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));
    await findToast('View “Drafts” applied.');
    await open(user);
    await user.click(
      await screen.findByRole('menuitem', { name: 'Rename “Drafts”…' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Taken');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'A view called “Taken” already exists here.',
      ),
    ).toBeVisible();
  });

  it('offers no rename or delete on a view the user may not change', async () => {
    useViewsApi({
      views: [
        view({
          visibility: 'tenant',
          mine: false,
          editable: false,
        }),
      ],
    });
    const user = userEvent.setup();
    await renderList();
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Drafts' }));
    await findToast('View “Drafts” applied.');
    await open(user);
    expect(
      await screen.findByRole('menuitem', { name: 'Save the current view…' }),
    ).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull();
  });
});
