import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it } from 'vitest';
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
  } = {},
) {
  const calls = {
    exports: [] as unknown[],
    imports: [] as Record<string, string>[],
    /** The query string of each list request. */
    lists: [] as string[],
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
      return pageOf(
        (options.list ?? []).filter((item) => !kind || item.kind === kind),
        url,
      );
    }),
    http.get('/v1/bulk', ({ request }) =>
      pageOf(options.bulk ?? [], new URL(request.url)),
    ),
    http.get('/v1/data/transfers/:id', ({ params }) => {
      const found = options.transfers?.[params.id as string];
      if (!found) return problem(404, 'not_found');
      return HttpResponse.json(typeof found === 'function' ? found() : found);
    }),
  );
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});

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
    useTransferApi({ catalog: { exports: [], imports: [] } });
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
    result: { rows: 3, url: `https://files.test/${id}.csv` },
  });

  it("lists the API's transfers and bulk runs, not this browser's", async () => {
    useSignedIn(ALL);
    // Nothing in localStorage: another device started these.
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
