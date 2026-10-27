import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArchiveRestoreIcon, Trash2Icon } from 'lucide-react';
import { http, HttpResponse } from 'msw/http';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { useMemo, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ListPage, type ListPageProps } from '@/components/list-page';
import { useRecycleBin } from '@/components/records/recycle-bin';
import { useCan } from '@/lib/features';
import type { Features } from '@/lib/session';
import type { ListColumn, ListPath } from '@/lib/list-query';
import { renderComponent } from '@/test/render-component';
import { problem, server } from '@/test/server';
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

type Answer = { status?: number; body: Record<string, unknown> };

/**
 * `POST /v1/test-items/bulk` answers `answer`; `GET /v1/bulk/{id}` walks
 * through `job` (one entry per poll, the last repeated). The list says how
 * many records match (`total`) and searches, so "all matching" has a filter.
 */
function useBulkApi(
  options: {
    answer?: Answer;
    job?: unknown[];
    total?: number;
    deleted?: boolean;
    /** The API refuses to start the run (503). */
    refuse?: boolean;
  } = {},
) {
  const calls = {
    bulk: [] as { body: unknown; key: string | null }[],
    lists: [] as string[],
    polls: 0,
  };
  server.use(
    http.get('/v1/lists/:subject', () =>
      HttpResponse.json({
        subject: 'TestItem',
        fields: [
          {
            name: 'title',
            type: 'string',
            operators: ['contains'],
            sortable: true,
            custom: false,
          },
        ],
        select: ['id', 'title', 'createdAt'],
        search: true,
        recycleBin: true,
        defaultSort: '-createdAt',
        limits: { defaultLimit: 50, maxLimit: 100 },
      }),
    ),
    http.get(PATH, ({ request }) => {
      const url = new URL(request.url);
      calls.lists.push(url.search);
      const bin = url.searchParams.get('deleted') === 'true';
      const rows = items(options.deleted ? DELETED_AT : null).filter(
        (item) => !!item.deletedAt === bin,
      );
      return HttpResponse.json({
        items: rows,
        page: 1,
        pageCount: 1,
        total: options.total ?? rows.length,
      });
    }),
    http.post(`${PATH}/bulk`, async ({ request }) => {
      calls.bulk.push({
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      if (options.refuse) {
        return problem(503, 'service_unavailable');
      }
      const answer = options.answer ?? {
        body: { done: 2, failed: 0, skipped: 0, results: [] },
      };
      return HttpResponse.json(answer.body, { status: answer.status ?? 200 });
    }),
    http.get('/v1/bulk/:id', () => {
      const steps = options.job ?? [];
      const step = steps[Math.min(calls.polls, steps.length - 1)];
      calls.polls += 1;
      return step ? HttpResponse.json(step) : problem(404, 'not_found');
    }),
  );
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

async function choose(...titles: string[]) {
  const user = userEvent.setup();
  for (const title of titles) {
    const row = (await screen.findByText(title)).closest('tr')!;
    await user.click(within(row).getByRole('checkbox', { name: 'Select row' }));
  }
  return user;
}

const bar = () => screen.findByRole('toolbar', { name: 'Selection actions' });

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
    await waitFor(() =>
      expect(
        screen.queryByRole('toolbar', { name: 'Selection actions' }),
      ).not.toBeInTheDocument(),
    );
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
        body: {
          done: 2,
          failed: 0,
          skipped: 0,
          results: [
            { id: A, status: 'done' },
            { id: B, status: 'done' },
          ],
        },
      },
    });
    await renderList();
    const user = await choose('Old plan', 'Older plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Delete 2 records?',
    });
    expect(calls.bulk).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    const run = await screen.findByRole('dialog', { name: 'Deleting' });
    expect(
      await within(run).findByText('2 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(calls.bulk).toEqual([
      { body: { action: 'delete', ids: [A, B] }, key: expect.any(String) },
    ]);
    // The run ended: the selection is gone.
    await waitFor(() =>
      expect(
        screen.queryByRole('toolbar', { name: 'Selection actions' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('sends nothing when the question is answered with Cancel', async () => {
    const calls = useBulkApi();
    await renderList();
    const user = await choose('Old plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Delete 1 record?',
    });
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
        body: {
          done: 1,
          failed: 1,
          skipped: 0,
          results: [
            { id: A, status: 'done' },
            {
              id: B,
              status: 'failed',
              error: { code: 'forbidden', message: 'It is locked.' },
            },
          ],
        },
      },
    });
    await renderList();
    const user = await choose('Old plan', 'Older plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete 2 records?' }),
      ).getByRole('button', { name: 'Delete' }),
    );
    const problems = await screen.findByRole('list', {
      name: 'Records not done',
    });
    expect(within(problems).getAllByRole('listitem')).toHaveLength(1);
    expect(within(problems).getByText(/It is locked\./)).toBeVisible();
  });

  it('follows a run the API queued, until it ends', async () => {
    useBulkApi({
      answer: { status: 202, body: { id: 'job-1', status: 'queued' } },
      job: [
        {
          id: 'job-1',
          name: 'test-items',
          action: 'delete',
          status: 'running',
          progress: { processed: 100, done: 99, failed: 1 },
        },
        {
          id: 'job-1',
          name: 'test-items',
          action: 'delete',
          status: 'completed',
          progress: { processed: 150, done: 149, failed: 1 },
          result: { done: 149, failed: 1, skipped: 0, results: [] },
        },
      ],
    });
    await renderList();
    const user = await choose('Old plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete 1 record?' }),
      ).getByRole('button', { name: 'Delete' }),
    );
    const run = await screen.findByRole('dialog', { name: 'Deleting' });
    expect(
      await within(run).findByText('100 processed: 99 done, 1 failed.'),
    ).toBeVisible();
    // Polled every second.
    expect(
      await within(run).findByText(
        '149 done, 1 failed, 0 skipped.',
        {},
        { timeout: 4000 },
      ),
    ).toBeVisible();
  });

  it("acts on every match of the list's search, as a filter", async () => {
    const calls = useBulkApi({
      total: 120,
      answer: { status: 202, body: { id: 'job-2', status: 'queued' } },
      job: [
        {
          id: 'job-2',
          name: 'test-items',
          action: 'delete',
          status: 'completed',
          progress: { processed: 120, done: 120, failed: 0 },
          result: { done: 120, failed: 0, skipped: 0, results: [] },
        },
      ],
    });
    await renderList('q=plan');
    const user = userEvent.setup();
    await screen.findByText('Old plan');
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    const toolbar = await bar();
    expect(within(toolbar).getByText('2 selected')).toBeVisible();
    await user.click(
      within(toolbar).getByRole('button', {
        name: 'Select all 120 matching',
      }),
    );
    expect(within(toolbar).getByText('120 selected')).toBeVisible();
    await user.click(within(toolbar).getByRole('button', { name: 'Delete' }));
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete 120 records?' }),
      ).getByRole('button', { name: 'Delete' }),
    );
    expect(
      await screen.findByText('120 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(calls.bulk.map((call) => call.body)).toEqual([
      { action: 'delete', filter: { q: 'plan' } },
    ]);
  });

  it('offers no "all matching" without a filter (a run needs one)', async () => {
    useBulkApi({ total: 120 });
    await renderList();
    const user = userEvent.setup();
    await screen.findByText('Old plan');
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    const toolbar = await bar();
    expect(within(toolbar).getByText('2 selected')).toBeVisible();
    expect(
      within(toolbar).queryByRole('button', { name: /Select all 120/ }),
    ).not.toBeInTheDocument();
  });

  it('closes the run dialog and says why when the API refuses to start the run', async () => {
    const calls = useBulkApi({ refuse: true });
    await renderList();
    const user = await choose('Old plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete 1 record?' }),
      ).getByRole('button', { name: 'Delete' }),
    );

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

    const run = await screen.findByRole('dialog', { name: 'Changing' });
    expect(
      await within(run).findByText('2 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(calls.bulk.map((call) => call.body)).toEqual([
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
    const run = await screen.findByRole('dialog', { name: 'Restoring' });
    expect(
      await within(run).findByText('2 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(calls.bulk.map((call) => call.body)).toEqual([
      { action: 'restore', ids: [A, B] },
    ]);
    // The bin was asked for, not the live list.
    expect(
      calls.lists.every((search) =>
        new URLSearchParams(search).has('deleted', 'true'),
      ),
    ).toBe(true);
  });
});
