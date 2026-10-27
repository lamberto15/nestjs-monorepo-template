import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { renderComponent } from '@/test/render-component';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { catalogQuery } from './api';
import { parseCsv, parseRowErrors } from './csv';
import { ExportButton } from './export-button';
import { ImportButton } from './import-button';

// The exports and imports of a test-only subject (`test-items`): what a
// feature's list offers, without any feature's pages.
const ALL = [
  'TestItem.read',
  'TestItem.create',
  'TestItem.delete',
  'TestItem.restore',
];

const catalog = {
  importLimits: { maxBytes: 50 * 1024 * 1024, maxRows: 1_000_000 },
  exports: [
    {
      name: 'test-items',
      columns: ['id', 'title', 'createdAt'],
      formats: ['csv', 'json', 'xlsx'],
    },
  ],
  imports: [
    {
      name: 'test-items',
      formats: ['csv', 'json', 'xlsx'],
      matchKeys: [] as string[],
      columns: [
        { name: 'title', type: 'string', required: true, max: 200 },
        { name: 'body', type: 'string', required: false },
      ],
      template: '/v1/data/imports/test-items/template',
    },
  ],
};

type Transfer = Record<string, unknown>;

/** The data routes; `transfers` answers by id. */
function useTransferApi(
  options: {
    catalog?: typeof catalog;
    transfers?: Record<string, Transfer | (() => Transfer)>;
    /** Every transfer of the caller, newest first (`GET /v1/data/transfers`). */
    list?: Transfer[];
    /** The caller's bulk runs, newest first (`GET /v1/bulk`). */
    bulk?: Record<string, unknown>[];
    pageSize?: number;
    /** The caller's account exports (`GET /v1/account/exports`). */
    account?: Transfer[];
    /**
     * A filtered first page that comes back empty with a next cursor (the
     * API reads a bounded number of entries per page).
     */
    sparse?: boolean;
  } = {},
) {
  const calls = {
    exports: [] as unknown[],
    imports: [] as Record<string, string>[],
    /** The query string of each list request. */
    lists: [] as string[],
    /** The query string of each bulk list request. */
    bulks: [] as string[],
    /** The query string of each account exports request. */
    accounts: [] as string[],
  };
  /** Cursor paging as the API does it: the cursor is the offset. */
  const pageOf = (all: unknown[], url: URL) => {
    const size = options.pageSize ?? 20;
    const from = Number(url.searchParams.get('cursor') ?? 0);
    const next = from + size;
    return HttpResponse.json({
      items: all.slice(from, next),
      nextCursor: next < all.length ? String(next) : null,
    });
  };
  server.use(
    http.get('/v1/data', () => HttpResponse.json(options.catalog ?? catalog)),
    http.post('/v1/data/exports', async ({ request }) => {
      calls.exports.push(await request.json());
      return HttpResponse.json(
        { id: 'export-1', status: 'queued' },
        { status: 202 },
      );
    }),
    http.post('/v1/data/imports', async ({ request }) => {
      // The raw multipart text: jsdom's File is not undici's, so
      // `request.formData()` cannot read what the page sent.
      const raw = await request.text();
      const part = (name: string) =>
        new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`).exec(raw)?.[1];
      calls.imports.push({
        name: part('name') ?? '',
        dryRun: part('dryRun') ?? '',
        ...(part('matchOn') && { matchOn: part('matchOn') }),
        file: /filename="([^"]*)"/.exec(raw)?.[1] ?? '',
      });
      return HttpResponse.json(
        { id: 'import-1', status: 'queued' },
        { status: 202 },
      );
    }),
    http.get('/v1/data/transfers', ({ request }) => {
      const url = new URL(request.url);
      calls.lists.push(url.search);
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      if (options.sparse && status && !url.searchParams.get('cursor')) {
        return HttpResponse.json({ items: [], nextCursor: '0' });
      }
      return pageOf(
        (options.list ?? []).filter(
          (item) =>
            (!kind || item.kind === kind) &&
            (!status || item.status === status),
        ),
        url,
      );
    }),
    http.get('/v1/bulk', ({ request }) => {
      const url = new URL(request.url);
      calls.bulks.push(url.search);
      const status = url.searchParams.get('status');
      return pageOf(
        (options.bulk ?? []).filter((run) => !status || run.status === status),
        url,
      );
    }),
    http.get('/v1/account/exports', ({ request }) => {
      const url = new URL(request.url);
      calls.accounts.push(url.search);
      return pageOf(options.account ?? [], url);
    }),
    http.get('/v1/data/transfers/:id', ({ params }) => {
      const found = options.transfers?.[params.id as string];
      if (!found) return problem(404, 'not_found');
      return HttpResponse.json(typeof found === 'function' ? found() : found);
    }),
  );
  return calls;
}

describe('exporting from a list', () => {
  it('exports what the list shows, then offers the file', async () => {
    const calls = useTransferApi({
      transfers: {
        'export-1': {
          id: 'export-1',
          kind: 'export',
          name: 'test-items',
          format: 'xlsx',
          status: 'completed',
          progress: { processed: 3 },
          result: { rows: 3, url: 'https://files.test/test-items.xlsx' },
        },
      },
    });
    // As a list searched for "Q3" renders it (exportFilters(params)).
    await renderComponent(
      <ExportButton exporter="test-items" filters={{ q: 'Q3' }} />,
      { can: ALL },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    expect(
      within(dialog).getByText(/The records the list shows now/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('combobox', { name: 'Format' }));
    await user.click(
      await screen.findByRole('option', { name: 'Excel (.xlsx)' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Start the export' }),
    );

    const download = await within(dialog).findByRole('link', {
      name: 'Download (xlsx)',
    });
    expect(download).toHaveAttribute(
      'href',
      'https://files.test/test-items.xlsx',
    );
    expect(within(dialog).getByText('3 rows exported.')).toBeVisible();
    expect(calls.exports).toEqual([
      { name: 'test-items', format: 'xlsx', filters: { q: 'Q3' } },
    ]);
  });

  it('offers no export or import the user may not run', async () => {
    useTransferApi({ catalog: { ...catalog, exports: [], imports: [] } });
    const { queryClient } = await renderComponent(
      <>
        <ExportButton exporter="test-items" filters={{}} />
        <ImportButton importer="test-items" />
      </>,
      { can: ALL },
    );
    await waitFor(() =>
      expect(queryClient.getQueryState(catalogQuery.queryKey)?.status).toBe(
        'success',
      ),
    );
    expect(
      screen.queryByRole('button', { name: 'Export' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Import' }),
    ).not.toBeInTheDocument();
  });

  it('shows a failed export', async () => {
    useTransferApi({
      transfers: {
        'export-1': {
          id: 'export-1',
          kind: 'export',
          name: 'test-items',
          format: 'csv',
          status: 'failed',
          progress: {},
          error: 'The storage is unavailable.',
        },
      },
    });
    await renderComponent(<ExportButton exporter="test-items" filters={{}} />, {
      can: ALL,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    expect(within(dialog).getByText(/Every record you may read/)).toBeVisible();
    await user.click(
      within(dialog).getByRole('button', { name: 'Start the export' }),
    );
    expect(
      await within(dialog).findByText('The storage is unavailable.'),
    ).toBeVisible();
  });
});

describe('matched imports', () => {
  it('sends only the match key the user selected', async () => {
    useSignedIn(ALL);
    const calls = useTransferApi({
      catalog: {
        ...catalog,
        imports: [{ ...catalog.imports[0]!, matchKeys: ['id', 'number'] }],
      },
    });
    await renderApp('/transfers/import?name=test-items');
    const user = userEvent.setup();
    const match = await screen.findByRole('combobox', {
      name: 'Match on (optional)',
    });
    await user.click(match);
    await user.click(
      await screen.findByRole('option', { name: 'Update matching id' }),
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(
        ['id,title\n00000000-0000-4000-8000-000000000001,A\n'],
        'notes.csv',
        { type: 'text/csv' },
      ),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Check the file' }),
    );
    await waitFor(() => expect(calls.imports).toHaveLength(1));
    expect(calls.imports[0]).toMatchObject({ matchOn: 'id' });
  });
});

describe('importing a file', () => {
  it('shows the columns and the templates', async () => {
    useSignedIn(ALL);
    useTransferApi();
    await renderApp('/transfers/import?name=test-items');
    const columns = await screen.findByRole('table', {
      name: 'Columns it takes',
    });
    const title = within(columns).getByRole('row', { name: /title/ });
    expect(within(title).getByText('Yes')).toBeVisible();
    expect(screen.getByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      '/v1/data/imports/test-items/template?format=csv',
    );
    expect(screen.getByRole('link', { name: 'Excel (.xlsx)' })).toHaveAttribute(
      'href',
      '/v1/data/imports/test-items/template?format=xlsx',
    );
  });

  it('uses the server catalog row and byte limits', async () => {
    useSignedIn(ALL);
    useTransferApi({
      catalog: { ...catalog, importLimits: { maxBytes: 1234, maxRows: 77 } },
    });
    await renderApp('/transfers/import?name=test-items');
    expect(
      await screen.findByText('This import can contain up to 77 rows.'),
    ).toBeVisible();
    expect(screen.getByText('One file, up to 1.2 kB.')).toBeVisible();
  });

  it('checks a file without writing, then lists the refused rows', async () => {
    useSignedIn(ALL);
    const calls = useTransferApi({
      transfers: {
        'import-1': {
          id: 'import-1',
          kind: 'import',
          name: 'test-items',
          format: 'csv',
          status: 'completed',
          progress: { processed: 3 },
          result: {
            rows: 3,
            imported: 2,
            failed: 1,
            dryRun: true,
            errorsUrl: 'https://files.test/errors.csv',
          },
        },
      },
    });
    server.use(
      http.get(
        'https://files.test/errors.csv',
        () =>
          new HttpResponse(
            '\uFEFFrow,field,message\r\n3,title,"Enter a title, please"\r\n',
            { headers: { 'content-type': 'text/csv' } },
          ),
      ),
    );
    await renderApp('/transfers/import?name=test-items');
    const user = userEvent.setup();
    const check = await screen.findByRole('button', { name: 'Check the file' });
    expect(check).toBeDisabled();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(['title\nA\nB\n'], 'test-items.csv', { type: 'text/csv' }),
    );
    await user.click(check);

    expect(
      await screen.findByText(
        'Checked 3 rows: 2 valid, 1 refused. Nothing was written.',
      ),
    ).toBeVisible();
    const refused = await screen.findByRole('table', { name: 'Refused rows' });
    expect(within(refused).getByText('Enter a title, please')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Download the refused rows (CSV)' }),
    ).toHaveAttribute('href', 'https://files.test/errors.csv');
    expect(calls.imports).toEqual([
      { name: 'test-items', dryRun: 'true', file: 'test-items.csv' },
    ]);
  });

  it('writes the rows when the check is turned off', async () => {
    useSignedIn(ALL);
    const calls = useTransferApi({
      transfers: {
        'import-1': {
          id: 'import-1',
          kind: 'import',
          name: 'test-items',
          format: 'csv',
          status: 'completed',
          progress: { processed: 2 },
          result: { rows: 2, imported: 2, failed: 0 },
        },
      },
    });
    await renderApp('/transfers/import?name=test-items');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('switch', { name: 'Only check the file' }),
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(['title\nA\nB\n'], 'test-items.csv', { type: 'text/csv' }),
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(
      await screen.findByText('2 rows read: 2 imported, 0 refused.'),
    ).toBeVisible();
    expect(calls.imports).toEqual([
      { name: 'test-items', dryRun: 'false', file: 'test-items.csv' },
    ]);
  });

  it('says so when there is nothing to import', async () => {
    useSignedIn(['TestItem.read']);
    useTransferApi({ catalog: { ...catalog, imports: [] } });
    await renderApp('/transfers/import');
    expect(
      await screen.findByText('There is nothing you may import.'),
    ).toBeVisible();
  });
});

describe('your exports and imports', () => {
  const exported = (id: string, name: string): Transfer => ({
    id,
    kind: 'export',
    name,
    format: 'csv',
    status: 'completed',
    progress: { processed: 3 },
    createdAt: '2026-10-18T09:00:00.000Z',
    finishedAt: '2026-10-18T09:01:00.000Z',
    expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    result: { rows: 3, url: `https://files.test/${id}.csv` },
  });

  it("lists the API's transfers and bulk runs, not this browser's", async () => {
    useSignedIn(ALL);
    // Nothing is kept in this browser: another device started these.
    const running = {
      id: 'running',
      kind: 'import',
      name: 'test-items',
      format: 'csv',
      status: 'running',
      progress: { processed: 40 },
    };
    useTransferApi({
      list: [running, exported('done', 'test-items')],
      transfers: { running, done: exported('done', 'test-items') },
      bulk: [
        {
          id: 'b1',
          name: 'test-items',
          action: 'delete',
          status: 'completed',
          progress: { processed: 5 },
          result: { done: 3, failed: 1, skipped: 1 },
        },
      ],
    });
    await renderApp('/transfers');
    const list = await screen.findByRole('list', {
      name: 'Exports and imports',
    });
    expect(
      await within(list).findByText('Working… 40 rows so far.'),
    ).toBeVisible();
    expect(
      await within(list).findByRole('link', { name: 'Download (csv)' }),
    ).toHaveAttribute('href', 'https://files.test/done.csv');
    const bulk = await screen.findByRole('list', { name: 'Bulk runs' });
    expect(
      within(bulk).getByText('3 done, 1 failed, 1 skipped.'),
    ).toBeVisible();
  });

  it('pages by cursor and filters by kind on the server', async () => {
    useSignedIn(ALL);
    const list = [
      exported('e1', 'first-export'),
      { ...exported('i1', 'an-import'), kind: 'import' },
      exported('e2', 'second-export'),
    ];
    const calls = useTransferApi({
      list,
      transfers: Object.fromEntries(list.map((item) => [item.id, item])),
      pageSize: 2,
    });
    await renderApp('/transfers');
    const user = userEvent.setup();
    expect(await screen.findByText('first-export')).toBeVisible();
    expect(screen.queryByText('second-export')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('second-export')).toBeVisible();
    expect(calls.lists.at(-1)).toContain('cursor=2');

    await user.click(screen.getByRole('combobox', { name: 'Show' }));
    await user.click(await screen.findByRole('option', { name: 'Imports' }));
    await waitFor(() => expect(calls.lists.at(-1)).toContain('kind=import'));
    await waitFor(() => expect(screen.queryByText('first-export')).toBeNull());
    expect(await screen.findByText('an-import')).toBeVisible();
  });

  it('shows when each started, ended and stops being kept', async () => {
    useSignedIn(ALL);
    useTransferApi({ list: [exported('done', 'test-items')] });
    await renderApp('/transfers');
    const list = await screen.findByRole('list', {
      name: 'Exports and imports',
    });
    expect(
      await within(list).findByText(/^Started Oct 18, 2026/),
    ).toBeVisible();
    expect(within(list).getByText(/^Finished Oct 18, 2026/)).toBeVisible();
    expect(within(list).getByText(/^Kept until /)).toBeVisible();
  });

  it('filters by status on the server, bulk runs too', async () => {
    useSignedIn(ALL);
    const failed = {
      ...exported('bad', 'failed-export'),
      status: 'failed',
      error: 'The storage is unavailable.',
    };
    const calls = useTransferApi({
      list: [exported('ok', 'good-export'), failed],
      bulk: [
        {
          id: 'b1',
          name: 'test-items',
          action: 'delete',
          status: 'completed',
          progress: { processed: 5 },
          result: { done: 5, failed: 0, skipped: 0 },
        },
      ],
    });
    await renderApp('/transfers');
    const user = userEvent.setup();
    expect(await screen.findByText('good-export')).toBeVisible();
    expect(
      await screen.findByText('5 done, 0 failed, 0 skipped.'),
    ).toBeVisible();

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));
    expect(await screen.findByText('failed-export')).toBeVisible();
    expect(
      await screen.findByText('The storage is unavailable.'),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByText('good-export')).toBeNull());
    expect(calls.lists.at(-1)).toContain('status=failed');
    expect(calls.bulks.at(-1)).toContain('status=failed');
    // The bulk run was not failed: the server left it out.
    expect(screen.queryByText('5 done, 0 failed, 0 skipped.')).toBeNull();
  });

  it('offers "Show more" when a filtered page is empty but not the last', async () => {
    useSignedIn(ALL);
    const calls = useTransferApi({
      list: [exported('ok', 'good-export')],
      sparse: true,
    });
    await renderApp('/transfers');
    const user = userEvent.setup();
    expect(await screen.findByText('good-export')).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Done' }));
    // Not "nothing yet": the API says there is more to read.
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('good-export')).toBeVisible();
    expect(calls.lists.at(-1)).toContain('cursor=0');
  });

  it('says so when nothing has the status', async () => {
    useSignedIn(ALL);
    useTransferApi({ list: [exported('ok', 'good-export')] });
    await renderApp('/transfers');
    const user = userEvent.setup();
    expect(await screen.findByText('good-export')).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Running' }));
    expect(await screen.findByText('Nothing with this status.')).toBeVisible();
  });

  it('does not offer the link of a transfer the API no longer keeps', async () => {
    useSignedIn(ALL);
    useTransferApi({
      list: [
        {
          ...exported('old', 'old-export'),
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    });
    await renderApp('/transfers');
    expect(
      await screen.findByText(
        'This transfer is no longer kept. Start it again for a new file.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Download (csv)' })).toBeNull();
  });

  it("shows the account exports, across tenants, from the API's own list", async () => {
    useSignedIn(ALL);
    const account = {
      ...exported('acc', 'account-export'),
      format: 'json',
      result: { rows: 9, url: 'https://files.test/acc.json' },
    };
    const calls = useTransferApi({
      list: [exported('ok', 'good-export')],
      account: [account],
    });
    await renderApp('/transfers');
    const user = userEvent.setup();
    const accounts = await screen.findByRole('list', {
      name: 'Account exports',
    });
    expect(
      await within(accounts).findByRole('link', { name: 'Download (json)' }),
    ).toHaveAttribute('href', 'https://files.test/acc.json');
    expect(within(accounts).getByText('Account export')).toBeVisible();
    expect(screen.getByText('good-export')).toBeVisible();

    // Its own filter: the tenant's transfers are not asked for.
    const before = calls.lists.length;
    await user.click(screen.getByRole('combobox', { name: 'Show' }));
    await user.click(
      await screen.findByRole('option', { name: 'Account exports' }),
    );
    await waitFor(() => expect(screen.queryByText('good-export')).toBeNull());
    expect(screen.getByText('account-export')).toBeVisible();
    expect(calls.lists).toHaveLength(before);
  });

  it('keeps nothing of the list in this browser', async () => {
    useSignedIn(ALL);
    useTransferApi({ list: [exported('ok', 'good-export')] });
    await renderApp('/transfers');
    expect(await screen.findByText('good-export')).toBeVisible();
    for (const store of [localStorage, sessionStorage]) {
      const kept = Array.from({ length: store.length }, (_, index) => {
        const key = store.key(index) ?? '';
        return `${key}=${store.getItem(key) ?? ''}`;
      });
      expect(kept.join('\n')).not.toMatch(/transfer|export|import/i);
    }
  });

  it('says when the list cannot be loaded', async () => {
    useSignedIn(ALL);
    useTransferApi();
    server.use(
      http.get('/v1/data/transfers', () => problem(500, 'internal_error')),
    );
    await renderApp('/transfers');
    expect(
      await screen.findByText('The list could not be loaded.'),
    ).toBeVisible();
  });

  it('says when there is nothing yet', async () => {
    useSignedIn(ALL);
    useTransferApi();
    await renderApp('/transfers');
    expect(
      await screen.findByText(
        'Nothing yet. Export from a list, or import a file.',
      ),
    ).toBeVisible();
  });
});

describe('the refused rows report', () => {
  it('reads quoted cells, doubled quotes and line breaks', () => {
    expect(parseCsv('a,"b ""c""","d\ne"\r\n1,2,3')).toEqual([
      ['a', 'b "c"', 'd\ne'],
      ['1', '2', '3'],
    ]);
  });

  it('skips the header and empty lines, and the byte-order mark', () => {
    expect(
      parseRowErrors('\uFEFFrow,field,message\n2,title,Too long\n\n'),
    ).toEqual([{ row: '2', field: 'title', message: 'Too long' }]);
  });
});
