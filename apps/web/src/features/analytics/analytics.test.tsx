import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server, signedInUser } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

const engine = vi.hoisted(() => ({
  loadLocalFile: vi.fn(),
  queryDataset: vi.fn(),
  disposeDataset: vi.fn(),
  terminateAnalyticsEngine: vi.fn(),
}));

vi.mock('./engine', () => engine);

const dataset = {
  id: 'session-1',
  name: 'records.csv',
  rowCount: 2,
  columns: [
    {
      name: 'city',
      type: 'VARCHAR',
      nullCount: 0,
      distinctCount: 2,
      min: null,
      max: null,
    },
    {
      name: 'amount',
      type: 'DOUBLE',
      nullCount: 0,
      distinctCount: 2,
      min: 2,
      max: 8,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  engine.loadLocalFile.mockResolvedValue(dataset);
  engine.queryDataset.mockResolvedValue({
    columns: ['city', 'amount'],
    rows: [{ city: 'Riga', amount: 2 }],
    totalRows: 1,
  });
  engine.disposeDataset.mockResolvedValue(undefined);
  server.use(
    http.get('/v1/settings', () =>
      HttpResponse.json({
        items: [
          { key: 'analytics.browser.enabled', value: true, type: 'boolean' },
        ],
      }),
    ),
  );
});

describe('browser analytics', () => {
  it('renders nested Parquet values with large integers and maps', async () => {
    engine.queryDataset.mockResolvedValue({
      columns: ['details'],
      rows: [
        {
          details: {
            count: 9007199254740993n,
            labels: new Map([['region', 'north']]),
          },
        },
      ],
      totalRows: 1,
    });
    useSignedIn([]);
    await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['parquet'], 'records.parquet')] },
    });
    expect(
      await screen.findByText(
        '{"count":"9007199254740993","labels":[["region","north"]]}',
      ),
    ).toBeVisible();
  });

  it('profiles and queries a local file without uploading it, and disposes it on navigation', async () => {
    useSignedIn([]);
    await renderApp('/analytics');
    const file = new File(['city,amount\nRiga,2'], 'records.csv', {
      type: 'text/csv',
    });
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [file] },
    });

    expect(
      await screen.findByRole('table', { name: 'Column profile' }),
    ).toBeVisible();
    expect(screen.getByText('Rows: 2')).toBeVisible();
    expect(await screen.findByRole('table', { name: 'Results' })).toBeVisible();
    expect(engine.loadLocalFile).toHaveBeenCalledWith(file);
    expect(engine.queryDataset).toHaveBeenCalledWith(
      dataset,
      expect.objectContaining({ limit: 100 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    await waitFor(() =>
      expect(engine.disposeDataset).toHaveBeenCalledWith(dataset),
    );
  });

  it('keeps the route inaccessible while the setting is off', async () => {
    server.use(
      http.get('/v1/settings', () => HttpResponse.json({ items: [] })),
    );
    useSignedIn([]);
    await renderApp('/analytics');
    expect(
      await screen.findByRole('heading', { name: 'Quick actions' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Analyze a local data file' }),
    ).not.toBeInTheDocument();
    expect(engine.loadLocalFile).not.toHaveBeenCalled();
  });

  it('fetches an authorized export only after the user asks to open it locally', async () => {
    const statusRequests: string[] = [];
    server.use(
      http.get('/v1/data/transfers/:id', ({ params }) => {
        statusRequests.push(String(params.id));
        return HttpResponse.json({
          id: 'export-1',
          kind: 'export',
          name: 'notes',
          format: 'csv',
          status: 'completed',
          progress: { processed: 2 },
          result: { rows: 2, url: 'https://files.test/notes.csv' },
        });
      }),
      http.get(
        'https://files.test/notes.csv',
        () =>
          new HttpResponse('title\nLaunch', {
            headers: { 'content-type': 'text/csv' },
          }),
      ),
    );
    useSignedIn([]);
    await renderApp('/analytics?transferId=export-1');
    expect(statusRequests).toEqual([]);

    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Load completed export into this browser',
      }),
    );
    await waitFor(() => expect(engine.loadLocalFile).toHaveBeenCalled());
    expect(statusRequests).toEqual(['export-1']);
    expect(engine.loadLocalFile.mock.calls[0]?.[0]).toMatchObject({
      name: 'notes.csv',
    });
  });

  it('sums a numeric DECIMAL column for a group and keeps the result page bounded', async () => {
    engine.loadLocalFile.mockResolvedValue({
      ...dataset,
      columns: [
        dataset.columns[0]!,
        {
          name: 'tax',
          type: 'DECIMAL(12, 2)',
          nullCount: 0,
          distinctCount: 2,
          min: 1.25,
          max: 4.5,
        },
      ],
    });
    useSignedIn([]);
    await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: {
        files: [new File(['city,amount,tax\nRiga,2,1.25'], 'records.csv')],
      },
    });
    await screen.findByRole('table', { name: 'Column profile' });

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Group by' }));

    await waitFor(() =>
      expect(engine.queryDataset).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          limit: 100,
          groupBy: 'city',
          aggregate: { column: 'tax', fn: 'sum' },
        }),
        expect.anything(),
      ),
    );
  });

  it('drops the row sort when grouping, and groups by the chosen column and aggregate', async () => {
    useSignedIn([]);
    await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['city,amount\nRiga,2'], 'records.csv')] },
    });
    await screen.findByRole('table', { name: 'Column profile' });

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    await user.click(await screen.findByRole('option', { name: 'amount' }));
    await waitFor(() =>
      expect(engine.queryDataset).toHaveBeenLastCalledWith(
        dataset,
        expect.objectContaining({
          sort: { column: 'amount', direction: 'asc' },
        }),
        expect.anything(),
      ),
    );

    await user.click(screen.getByRole('tab', { name: 'Group by' }));
    await waitFor(() =>
      expect(engine.queryDataset).toHaveBeenLastCalledWith(
        dataset,
        expect.objectContaining({
          limit: 100,
          groupBy: 'city',
          aggregate: { column: 'amount', fn: 'sum' },
          sort: { column: 'value', direction: 'desc' },
        }),
        expect.anything(),
      ),
    );

    await user.click(screen.getByRole('combobox', { name: 'Calculate' }));
    await user.click(await screen.findByRole('option', { name: 'Average' }));
    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        groupBy: 'city',
        aggregate: { column: 'amount', fn: 'avg' },
      }),
    );

    await user.click(screen.getByRole('combobox', { name: 'Calculate' }));
    await user.click(await screen.findByRole('option', { name: 'Count' }));
    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        groupBy: 'city',
        aggregate: { fn: 'count' },
      }),
    );
  });

  it('returns to the first page when the filter changes', async () => {
    engine.queryDataset.mockImplementation(async (_data, query) => ({
      columns: ['city', 'amount'],
      rows: [{ city: 'Riga', amount: query.offset }],
      totalRows: 250,
    }));
    useSignedIn([]);
    await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['city,amount\nRiga,2'], 'records.csv')] },
    });
    await screen.findByRole('table', { name: 'Column profile' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        offset: 100,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        offset: 0,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        offset: 100,
      }),
    );
    await user.click(screen.getByRole('combobox', { name: 'Filter column' }));
    await user.click(await screen.findByRole('option', { name: 'city' }));
    await user.click(screen.getByRole('combobox', { name: 'Operator' }));
    await user.click(await screen.findByRole('option', { name: 'Equals' }));
    await user.type(screen.getByLabelText('Value'), 'Riga');

    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        offset: 0,
        filters: [{ column: 'city', operator: 'eq', value: 'Riga' }],
      }),
    );
    expect(await screen.findByText('Riga')).toBeVisible();
  });

  it('terminates and clears the open file when its setting is turned off', async () => {
    let enabled = true;
    useSignedIn([]);
    server.use(
      http.get('/v1/settings', () =>
        HttpResponse.json({
          items: enabled
            ? [
                {
                  key: 'analytics.browser.enabled',
                  value: true,
                  type: 'boolean',
                },
              ]
            : [],
        }),
      ),
    );
    const { queryClient } = await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['city,amount\nRiga,2'], 'records.csv')] },
    });
    await screen.findByRole('table', { name: 'Column profile' });

    enabled = false;
    await queryClient.invalidateQueries({ queryKey: ['settings'] });

    await waitFor(() => {
      expect(screen.queryByText('records.csv')).not.toBeInTheDocument();
      expect(engine.terminateAnalyticsEngine).toHaveBeenCalled();
    });
  });

  it('terminates and clears the open file when the signed-in identity changes', async () => {
    let changed = false;
    useSignedIn([]);
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          user: {
            ...signedInUser.user,
            id: changed
              ? '0199a3f2-0000-7000-8000-000000000099'
              : signedInUser.user.id,
          },
        }),
      ),
    );
    const { queryClient } = await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['city,amount\nRiga,2'], 'records.csv')] },
    });
    await screen.findByRole('table', { name: 'Column profile' });

    changed = true;
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });

    await waitFor(() => {
      expect(screen.queryByText('records.csv')).not.toBeInTheDocument();
      expect(engine.terminateAnalyticsEngine).toHaveBeenCalled();
    });
  });

  it('ignores an export lookup that finishes after the tenant changes', async () => {
    let resolveStatus!: (response: Response) => void;
    let statusRequested = false;
    const statusResponse = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    let tenantChanged = false;
    useSignedIn([]);
    server.use(
      http.get('/v1/auth/me', () => {
        const me = signedInUser;
        return HttpResponse.json({
          ...me,
          tenant: tenantChanged
            ? { ...me.tenant!, id: '0199a3f2-0000-7000-8000-000000000099' }
            : me.tenant,
        });
      }),
      http.get('/v1/data/transfers/:id', () => {
        statusRequested = true;
        return statusResponse;
      }),
    );
    const { queryClient } = await renderApp('/analytics?transferId=export-1');
    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Load completed export into this browser',
      }),
    );
    await waitFor(() => expect(statusRequested).toBe(true));

    tenantChanged = true;
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    resolveStatus(
      HttpResponse.json({
        id: 'export-1',
        kind: 'export',
        name: 'notes',
        format: 'csv',
        status: 'completed',
        progress: { processed: 2 },
        result: { rows: 2, url: 'https://files.test/notes.csv' },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.loadLocalFile).not.toHaveBeenCalled();
  });

  it('does not start an export worker when navigation unmounts the page', async () => {
    let resolveStatus!: (response: Response) => void;
    let statusRequested = false;
    const statusResponse = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    server.use(
      http.get('/v1/data/transfers/:id', () => {
        statusRequested = true;
        return statusResponse;
      }),
      http.get(
        'https://files.test/notes.csv',
        () =>
          new HttpResponse('title\nLaunch', {
            headers: { 'content-type': 'text/csv' },
          }),
      ),
    );
    useSignedIn([]);
    const { router } = await renderApp('/analytics?transferId=export-1');
    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Load completed export into this browser',
      }),
    );
    await waitFor(() => expect(statusRequested).toBe(true));

    await router.navigate({ to: '/' });
    expect(engine.terminateAnalyticsEngine).toHaveBeenCalled();
    resolveStatus(
      HttpResponse.json({
        id: 'export-1',
        kind: 'export',
        name: 'notes',
        format: 'csv',
        status: 'completed',
        progress: { processed: 2 },
        result: { rows: 2, url: 'https://files.test/notes.csv' },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.loadLocalFile).not.toHaveBeenCalled();
  });

  it('disposes a file load cancelled by leaving the page', async () => {
    let resolveLoad!: (loaded: typeof dataset) => void;
    engine.loadLocalFile.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    useSignedIn([]);
    const { router } = await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['city,amount\nRiga,2'], 'records.csv')] },
    });
    await waitFor(() => expect(engine.loadLocalFile).toHaveBeenCalled());

    await router.navigate({ to: '/' });
    expect(engine.terminateAnalyticsEngine).toHaveBeenCalled();
    resolveLoad(dataset);
    await waitFor(() =>
      expect(engine.disposeDataset).toHaveBeenCalledWith(dataset),
    );
    expect(screen.queryByText('records.csv')).not.toBeInTheDocument();
  });

  it('shows a useful error when a local file cannot be read', async () => {
    engine.loadLocalFile.mockRejectedValue(new Error('unsupported file'));
    useSignedIn([]);
    await renderApp('/analytics');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['bad'], 'broken.csv')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The file could not be read or queried.',
    );
    expect(
      screen.queryByRole('table', { name: 'Results' }),
    ).not.toBeInTheDocument();
  });

  const chooseFile = (name = 'records.csv') =>
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['city,amount\nRiga,2'], name)] },
    });
  const profile = () => screen.findByRole('table', { name: 'Column profile' });

  it('takes the file from the upload control and removes it with its Close file button', async () => {
    useSignedIn([]);
    await renderApp('/analytics');
    const file = new File(['city,amount\nRiga,2'], 'records.csv', {
      type: 'text/csv',
    });
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const user = userEvent.setup();
    await user.upload(input, file);

    await profile();
    expect(engine.loadLocalFile).toHaveBeenCalledWith(file);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close file' }));
    await waitFor(() =>
      expect(engine.disposeDataset).toHaveBeenCalledWith(dataset),
    );
    expect(
      screen.queryByRole('table', { name: 'Column profile' }),
    ).not.toBeInTheDocument();
  });

  it('waits for the typing to pause before it filters, then queries once', async () => {
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();
    await profile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Filter column' }));
    await user.click(await screen.findByRole('option', { name: 'city' }));
    await waitFor(() => expect(screen.getByLabelText('Value')).toBeVisible());
    engine.queryDataset.mockClear();

    await user.type(screen.getByLabelText('Value'), 'Riga');
    expect(screen.getByLabelText('Value')).toHaveValue('Riga');
    expect(engine.queryDataset).not.toHaveBeenCalled();

    await waitFor(() => expect(engine.queryDataset).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(engine.queryDataset).toHaveBeenCalledTimes(1);
    expect(engine.queryDataset.mock.calls[0]?.[1]).toMatchObject({
      filters: [{ column: 'city', operator: 'contains', value: 'Riga' }],
    });
  });

  it('aborts a superseded query and never lets its late answer replace the newer one', async () => {
    let answerFirst!: (value: unknown) => void;
    engine.queryDataset.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerFirst = resolve;
        }),
    );
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();
    await profile();
    await waitFor(() => expect(engine.queryDataset).toHaveBeenCalledTimes(1));
    const first = engine.queryDataset.mock.calls[0]![2] as {
      signal: AbortSignal;
    };
    expect(first.signal.aborted).toBe(false);

    engine.queryDataset.mockResolvedValue({
      columns: ['city', 'value'],
      rows: [{ city: 'Newer', value: 3 }],
      totalRows: 1,
    });
    await userEvent
      .setup()
      .click(screen.getByRole('tab', { name: 'Group by' }));
    expect(await screen.findByText('Newer')).toBeVisible();
    expect(first.signal.aborted).toBe(true);

    answerFirst({
      columns: ['city', 'amount'],
      rows: [{ city: 'Stale', amount: 1 }],
      totalRows: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.getByText('Newer')).toBeVisible();
  });

  it('shows an indeterminate state with a Cancel button while a file loads, and Cancel ends the session', async () => {
    engine.loadLocalFile.mockReturnValue(new Promise(() => undefined));
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Reading the file',
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Cancel' }));

    expect(engine.terminateAnalyticsEngine).toHaveBeenCalled();
    expect(await screen.findByText(/^Cancelled\./)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancels a running query by ending the session, and offers the file again', async () => {
    engine.queryDataset.mockReturnValue(new Promise(() => undefined));
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();
    await profile();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Running the query',
    );
    engine.terminateAnalyticsEngine.mockClear();

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Cancel' }));

    expect(engine.terminateAnalyticsEngine).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole('table', { name: 'Column profile' }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/^Cancelled\./)).toBeVisible();
    expect(screen.getByLabelText('File')).toBeInTheDocument();
  });

  it('charts a group-by in a ChartContainer', async () => {
    engine.queryDataset.mockResolvedValue({
      columns: ['city', 'value'],
      rows: [
        { city: 'Riga', value: 3 },
        { city: 'Oslo', value: 1 },
      ],
      totalRows: 2,
    });
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();
    await profile();
    expect(
      screen.queryByRole('figure', { name: 'Chart of the groups' }),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole('tab', { name: 'Group by' }));

    const chart = await screen.findByRole('figure', {
      name: 'Chart of the groups',
    });
    expect(chart.querySelector('[data-slot="chart"]')).not.toBeNull();
  });

  it('charts a histogram of a number column', async () => {
    engine.queryDataset.mockImplementation(async (_data, query) =>
      query.histogram
        ? {
            columns: ['bin', 'value'],
            rows: [
              { bin: 2, value: 4 },
              { bin: 5, value: 1 },
            ],
            totalRows: 2,
          }
        : { columns: ['city'], rows: [], totalRows: 0 },
    );
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();
    await profile();

    await userEvent
      .setup()
      .click(screen.getByRole('tab', { name: 'Histogram' }));

    await waitFor(() =>
      expect(engine.queryDataset).toHaveBeenLastCalledWith(
        dataset,
        expect.objectContaining({
          limit: 100,
          histogram: { column: 'amount', bins: 20 },
        }),
        expect.anything(),
      ),
    );
    expect(
      await screen.findByRole('figure', { name: 'Histogram' }),
    ).toBeVisible();
  });

  it('charts a time series by day, week or month of a date column', async () => {
    engine.loadLocalFile.mockResolvedValue({
      ...dataset,
      columns: [
        ...dataset.columns,
        {
          name: 'created',
          type: 'TIMESTAMP',
          nullCount: 0,
          distinctCount: 2,
          min: null,
          max: null,
        },
      ],
    });
    engine.queryDataset.mockImplementation(async (_data, query) =>
      query.timeSeries
        ? {
            columns: ['bucket', 'value'],
            rows: [
              { bucket: '2026-01-05', value: 2 },
              { bucket: '2026-01-12', value: 5 },
            ],
            totalRows: 2,
          }
        : { columns: ['city'], rows: [], totalRows: 0 },
    );
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();
    await profile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('tab', { name: 'Time series' }));
    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        timeSeries: { column: 'created', unit: 'day' },
      }),
    );
    expect(
      await screen.findByRole('figure', { name: 'Time series chart' }),
    ).toBeVisible();

    await user.click(screen.getByRole('combobox', { name: 'Bucket by' }));
    await user.click(await screen.findByRole('option', { name: 'Week' }));
    await waitFor(() =>
      expect(engine.queryDataset.mock.calls.at(-1)?.[1]).toMatchObject({
        timeSeries: { column: 'created', unit: 'week' },
      }),
    );
  });

  it('disables the histogram and time series tabs when the file has no number or date column', async () => {
    engine.loadLocalFile.mockResolvedValue({
      ...dataset,
      columns: [dataset.columns[0]!],
    });
    useSignedIn([]);
    await renderApp('/analytics');
    chooseFile();
    await profile();

    expect(screen.getByRole('tab', { name: 'Histogram' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Time series' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
