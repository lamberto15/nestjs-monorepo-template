import { screen, waitFor, within } from '@testing-library/react';
import { ArchiveRestoreIcon, Trash2Icon } from 'lucide-react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { useMemo, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ListPage, type ListPageProps } from '@/components/list-page';
import { useRecycleBin } from '@/components/records/recycle-bin';
import { useCan } from '@/lib/features';
import type { Features } from '@/lib/session';
import type { ListColumn, ListPath } from '@/lib/list-query';
import {
  bodiesOf,
  bulkHandlers,
  bulkResult,
  deleteJob,
  queuedRun,
  type BulkAnswer,
} from '@/test/bulk-api';
import {
  askDelete,
  bar,
  choose,
  confirmDelete,
  expectNoBar,
  expectOneNotDone,
  expectRunDone,
  expectRunText,
  runDialog,
  selectPage,
} from '@/test/bulk-steps';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { findToast } from '@/test/toast';
import type { BulkPath } from './api';
import { useBulkActions, type BulkActionSpec } from './use-bulk-actions';

// The bulk actions (useBulkActions, useBulkRun) on a test-only list
// (`/v1/test-items`, as the API's tests use TestItem), not a feature's page:
// these tests stand when `pnpm feature:remove` takes a feature. A feature's
// own tests only check that its list is wired to them.

const PATH = '/v1/test-items';
// BulkPath and ListPage's `path` are typed on the client's routes, which have
// no test-only one: the casts, here.
const BULK = `${PATH}/bulk` as BulkPath;
type Row = { id: string; title: string };
const TestListPage = ListPage as unknown as (
  props: Omit<ListPageProps<ListPath>, 'path' | 'columns'> & {
    path: string;
    columns: ListColumn<Row>[];
  },
) => ReactNode;

const columns: ListColumn<Row>[] = [
  {
    id: 'title',
    accessorKey: 'title',
    header: 'Title',
    meta: { label: 'Title' },
  },
];

const ALL = ['TestItem.read', 'TestItem.delete', 'TestItem.restore'];
const A = '0199a3f2-0000-7000-8000-000000000601';
const B = '0199a3f2-0000-7000-8000-000000000602';
const DELETED_AT = '2026-10-17T10:00:00.000Z';

const items = (deletedAt: string | null) => [
  { id: A, title: 'Old plan', deletedAt },
  { id: B, title: 'Older plan', deletedAt },
];

/**
 * A list as a feature's route builds it: the actions follow the permissions
 * and the recycle bin (`?deleted=true`), the dialogs sit next to the list.
 * `update` is a third action with an `input`, which asks nothing first.
 */
function ItemsList(props: { withUpdate?: boolean }) {
  const bin = useRecycleBin();
  const canDelete = useCan('TestItem.delete');
  const canRestore = useCan('TestItem.restore');
  const specs = useMemo<BulkActionSpec[]>(
    () =>
      bin.deleted
        ? canRestore
          ? [{ action: 'restore', label: 'Restore', icon: ArchiveRestoreIcon }]
          : []
        : [
            ...(canDelete
              ? [
                  {
                    action: 'delete',
                    label: 'Delete',
                    icon: Trash2Icon,
                    confirm: true,
                  } satisfies BulkActionSpec,
                ]
              : []),
            ...(canDelete && props.withUpdate
              ? [
                  {
                    action: 'update',
                    label: 'Publish',
                    input: { status: 'published' },
                  } satisfies BulkActionSpec,
                ]
              : []),
          ],
    [bin.deleted, canDelete, canRestore, props.withUpdate],
  );
  const bulk = useBulkActions(BULK, specs);
  return (
    <>
      <TestListPage
        subject="TestItem"
        path={PATH}
        title="Test items"
        columns={columns}
        query={bin.deleted ? { deleted: 'true' } : undefined}
        bulkActions={specs.length > 0 ? bulk.render : undefined}
      />
      {bulk.dialogs}
    </>
  );
}

/**
 * `POST /v1/test-items/bulk` and the list's other routes (test/bulk-api):
 * `deleted` puts the records in the recycle bin.
 */
function useBulkApi(
  options: {
    answer?: BulkAnswer;
    job?: unknown[];
    total?: number;
    deleted?: boolean;
    /** The API refuses to start the run (503). */
    refuse?: boolean;
  } = {},
) {
  const { deleted, ...run } = options;
  const { calls, handlers } = bulkHandlers({
    path: PATH,
    subject: 'TestItem',
    records: () => items(deleted ? DELETED_AT : null),
    ...run,
  });
  server.use(...handlers);
  return calls;
}

function renderList(
  searchParams = '',
  can: readonly string[] = ALL,
  options: { features?: Partial<Features>; withUpdate?: boolean } = {},
) {
  return renderComponent(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory>
      <ItemsList withUpdate={options.withUpdate} />
    </NuqsTestingAdapter>,
    { can, features: options.features },
  );
}

describe('selecting rows', () => {
  it('shows the action bar with the count, and clears it', async () => {
    useBulkApi();
    await renderList();
    const user = await choose('Old plan', 'Older plan');
    const toolbar = await bar();
    expect(within(toolbar).getByText('2 selected')).toBeVisible();
    await user.click(
      within(toolbar).getByRole('button', { name: 'Clear the selection' }),
    );
    await expectNoBar();
    expect(
      screen.queryAllByRole('checkbox', { name: 'Select row', checked: true }),
    ).toHaveLength(0);
  });

  it('offers no selection without a bulk permission', async () => {
    useBulkApi();
    await renderList('', ['TestItem.read']);
    await screen.findByText('Old plan');
    expect(
      screen.queryByRole('checkbox', { name: 'Select row' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the actions in sight but off while the API refuses writes', async () => {
    const calls = useBulkApi();
    await renderList('', ALL, { features: { mode: 'read-only' } });
    const user = await choose('Old plan');
    const button = within(await bar()).getByRole('button', { name: 'Delete' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(
      screen.queryByRole('alertdialog', { name: 'Delete 1 record?' }),
    ).not.toBeInTheDocument();
    expect(calls.bulk).toEqual([]);
  });
});

describe('bulk delete', () => {
  it('asks first, then deletes the chosen records in one request', async () => {
    const calls = useBulkApi({
      answer: {
        body: bulkResult(2, 0, [
          { id: A, status: 'done' },
          { id: B, status: 'done' },
        ]),
      },
    });
    await renderList();
    const user = await choose('Old plan', 'Older plan');
    const confirm = await askDelete(user, 'Delete 2 records?');
    expect(calls.bulk).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await expectRunDone('Deleting');
    expect(calls.bulk).toEqual([
      { body: { action: 'delete', ids: [A, B] }, key: expect.any(String) },
    ]);
    // The run ended: the selection is gone.
    await expectNoBar();
  });

  it('sends nothing when the question is answered with Cancel', async () => {
    const calls = useBulkApi();
    await renderList();
    const user = await choose('Old plan');
    const confirm = await askDelete(user, 'Delete 1 record?');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: 'Delete 1 record?' }),
      ).not.toBeInTheDocument(),
    );
    expect(calls.bulk).toEqual([]);
  });

  it('lists the records it could not do, with the reason', async () => {
    useBulkApi({
      answer: {
        body: bulkResult(1, 1, [
          { id: A, status: 'done' },
          {
            id: B,
            status: 'failed',
            error: { code: 'forbidden', message: 'It is locked.' },
          },
        ]),
      },
    });
    await renderList();
    const user = await choose('Old plan', 'Older plan');
    await confirmDelete(user, 'Delete 2 records?');
    await expectOneNotDone(/It is locked\./);
  });

  it('follows a run the API queued, until it ends', async () => {
    useBulkApi({
      answer: queuedRun('job-1'),
      job: [
        deleteJob('job-1', 'test-items', 'running', 99, 1),
        deleteJob('job-1', 'test-items', 'completed', 149, 1),
      ],
    });
    await renderList();
    const user = await choose('Old plan');
    await confirmDelete(user, 'Delete 1 record?');
    const run = await runDialog('Deleting');
    await expectRunText(run, '100 processed: 99 done, 1 failed.');
    // Polled every second.
    await expectRunText(run, '149 done, 1 failed, 0 skipped.', 4000);
  });

  it("acts on every match of the list's search, as a filter", async () => {
    const calls = useBulkApi({
      total: 120,
      answer: queuedRun('job-2'),
      job: [deleteJob('job-2', 'test-items', 'completed', 120, 0)],
    });
    await renderList('q=plan');
    const { user, toolbar } = await selectPage('Old plan', 2);
    await user.click(
      within(toolbar).getByRole('button', {
        name: 'Select all 120 matching',
      }),
    );
    expect(within(toolbar).getByText('120 selected')).toBeVisible();
    await confirmDelete(user, 'Delete 120 records?');
    expect(
      await screen.findByText('120 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(bodiesOf(calls)).toEqual([
      { action: 'delete', filter: { q: 'plan' } },
    ]);
  });

  it('offers no "all matching" without a filter (a run needs one)', async () => {
    useBulkApi({ total: 120 });
    await renderList();
    const { toolbar } = await selectPage('Old plan', 2);
    expect(
      within(toolbar).queryByRole('button', { name: /Select all 120/ }),
    ).not.toBeInTheDocument();
  });

  it('closes the run dialog and says why when the API refuses to start the run', async () => {
    const calls = useBulkApi({ refuse: true });
    await renderList();
    const user = await choose('Old plan');
    await confirmDelete(user, 'Delete 1 record?');

    await findToast('service_unavailable (test)');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Deleting' }),
      ).not.toBeInTheDocument(),
    );
    expect(calls.bulk).toHaveLength(1);
  });
});

describe('bulk update', () => {
  it("sends the action's input, and asks nothing first", async () => {
    const calls = useBulkApi();
    await renderList('', ALL, { withUpdate: true });
    const user = await choose('Old plan', 'Older plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Publish' }),
    );

    await expectRunDone('Changing');
    expect(bodiesOf(calls)).toEqual([
      { action: 'update', ids: [A, B], input: { status: 'published' } },
    ]);
  });
});

describe('bulk restore', () => {
  it('restores from the recycle bin without asking', async () => {
    const calls = useBulkApi({ deleted: true });
    await renderList('deleted=true');
    const user = await choose('Old plan', 'Older plan');
    const toolbar = await bar();
    expect(
      within(toolbar).queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
    await user.click(within(toolbar).getByRole('button', { name: 'Restore' }));
    await expectRunDone('Restoring');
    expect(bodiesOf(calls)).toEqual([{ action: 'restore', ids: [A, B] }]);
    // The bin was asked for, not the live list.
    expect(
      calls.lists.every((search) =>
        new URLSearchParams(search).has('deleted', 'true'),
      ),
    ).toBe(true);
  });
});
