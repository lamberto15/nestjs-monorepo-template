import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

const engine = vi.hoisted(() => ({
  loadLocalFile: vi.fn(),
  checkDataset: vi.fn(),
  disposeDataset: vi.fn(),
  terminateAnalyticsEngine: vi.fn(),
}));

vi.mock('../analytics/engine', () => engine);

const catalog = {
  importLimits: { maxBytes: 50 * 1024 * 1024, maxRows: 1_000_000 },
  exports: [],
  imports: [
    {
      name: 'stock',
      formats: ['csv', 'json', 'xlsx'],
      matchKeys: ['sku'],
      columns: [
        { name: 'sku', type: 'text', required: true },
        { name: 'qty', type: 'number', required: true },
        { name: 'due', type: 'date', required: false },
      ],
      template: '/v1/data/imports/stock/template',
    },
  ],
};

const column = (name: string, type: string, nullCount = 0) => ({
  name,
  type,
  nullCount,
  distinctCount: 1,
  min: null,
  max: null,
});

const dataset = (id = 'd1') => ({
  id,
  name: 'stock.csv',
  engineVersion: 'v1.4.3',
  rowCount: 10,
  columns: [
    column('sku', 'VARCHAR', 3),
    column('qty', 'VARCHAR'),
    column('due', 'BIGINT'),
    column('colour', 'VARCHAR'),
  ],
});

const csv = (name = 'stock.csv') =>
  new File(['sku,qty,due,colour\nA-1,1,2,red\n'], name, { type: 'text/csv' });

function chooseFile(file: File) {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  return userEvent.upload(input, file);
}

function useImportApi(flag = true) {
  useSignedIn(['Stock.read']);
  server.use(
    http.get('/v1/data', () => HttpResponse.json(catalog)),
    http.get('/v1/settings', () =>
      HttpResponse.json({
        items: [
          { key: 'analytics.browser.enabled', value: flag, type: 'boolean' },
        ],
      }),
    ),
  );
}

async function openPage() {
  await renderApp('/transfers/import?name=stock');
  await screen.findByRole('table', { name: 'Columns it takes' });
}

beforeEach(() => {
  vi.clearAllMocks();
  engine.loadLocalFile.mockResolvedValue(dataset());
  engine.checkDataset.mockResolvedValue({
    duplicates: {
      column: 'sku',
      extraRows: 2,
      samples: [{ value: 'A-1', rows: 3 }],
    },
    unparseable: { qty: 2 },
  });
  engine.disposeDataset.mockResolvedValue(undefined);
});

describe('the local check on the import page', () => {
  it('does not load the engine or show the section while the flag is off', async () => {
    useImportApi(false);
    await openPage();
    await chooseFile(csv());
    expect(
      await screen.findByRole('button', { name: 'Check the file' }),
    ).toBeEnabled();
    expect(screen.queryByText('Local check (not authoritative)')).toBeNull();
    expect(engine.loadLocalFile).not.toHaveBeenCalled();
  });

  it('shows what the file gets wrong against the catalog, grouped', async () => {
    useImportApi();
    await openPage();
    await chooseFile(csv());
    const card = await screen.findByLabelText(
      'Local check (not authoritative)',
    );
    expect(
      await within(card).findByText('Read 10 rows and 4 columns.'),
    ).toBeVisible();
    expect(engine.loadLocalFile).toHaveBeenCalledWith(expect.any(File));
    expect(engine.checkDataset).toHaveBeenCalledWith(dataset(), {
      duplicateKey: 'sku',
      parse: [{ column: 'qty', as: 'number' }],
    });
    // Unknown columns.
    expect(
      within(card).getByText('Columns the import does not take'),
    ).toBeVisible();
    expect(within(card).getByText('colour')).toBeVisible();
    // Type problems: unparseable text, and a number where a date is expected.
    const types = within(card).getByRole('table', {
      name: 'Values that may not fit the column type',
    });
    expect(within(types).getByRole('row', { name: /qty/ })).toHaveTextContent(
      '2 values do not read as number',
    );
    expect(within(types).getByRole('row', { name: /due/ })).toHaveTextContent(
      'BIGINT',
    );
    // Duplicates of the match key (chosen from the file's header).
    expect(
      within(card).getByText('Repeated values of the match key sku'),
    ).toBeVisible();
    expect(
      within(card).getByText(
        'Rows repeating an earlier key: 2. Most repeated: A-1.',
      ),
    ).toBeVisible();
    // Null share of a required column.
    const nulls = within(card).getByRole('table', {
      name: 'Required columns with many empty values',
    });
    expect(within(nulls).getByRole('row', { name: /sku/ })).toHaveTextContent(
      '30% (3 of 10 rows)',
    );
    // The import itself is not blocked or changed.
    expect(
      screen.getByRole('button', { name: 'Check the file' }),
    ).toBeEnabled();
  });

  it('says nothing is wrong when nothing is, and that the server still decides', async () => {
    engine.loadLocalFile.mockResolvedValue({
      ...dataset(),
      columns: [
        column('sku', 'VARCHAR'),
        column('qty', 'BIGINT'),
        column('due', 'DATE'),
      ],
    });
    engine.checkDataset.mockResolvedValue({ unparseable: {} });
    useImportApi();
    await openPage();
    await chooseFile(csv());
    expect(
      await screen.findByText(
        /No problems found\. The server may still refuse rows\./,
      ),
    ).toBeVisible();
  });

  it('skips an Excel file with a note, without loading the engine', async () => {
    useImportApi();
    await openPage();
    await chooseFile(new File(['x'], 'stock.xlsx'));
    expect(
      await screen.findByText(/Excel files cannot be checked locally/),
    ).toBeVisible();
    expect(engine.loadLocalFile).not.toHaveBeenCalled();
  });

  it('disposes the previous dataset when another file is chosen', async () => {
    engine.loadLocalFile
      .mockResolvedValueOnce(dataset('first'))
      .mockResolvedValueOnce(dataset('second'));
    useImportApi();
    await openPage();
    await chooseFile(csv('one.csv'));
    await screen.findByText('Read 10 rows and 4 columns.');
    // The list holds one file: replacing it is removing it, then choosing.
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove the file' }),
    );
    await chooseFile(csv('two.csv'));
    await waitFor(() =>
      expect(engine.disposeDataset).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'first' }),
      ),
    );
    await waitFor(() => expect(engine.loadLocalFile).toHaveBeenCalledTimes(2));
  });

  it('ends the engine when the file is removed', async () => {
    useImportApi();
    await openPage();
    await chooseFile(csv());
    await screen.findByText('Read 10 rows and 4 columns.');
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove the file' }),
    );
    await waitFor(() =>
      expect(screen.queryByText('Local check (not authoritative)')).toBeNull(),
    );
    expect(engine.terminateAnalyticsEngine).toHaveBeenCalled();
  });

  it('cancels a running check by ending the engine', async () => {
    engine.loadLocalFile.mockReturnValue(new Promise(() => undefined));
    useImportApi();
    await openPage();
    await chooseFile(csv());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Cancel' }),
    );
    expect(engine.terminateAnalyticsEngine).toHaveBeenCalled();
    expect(
      await screen.findByText(/The local check was cancelled/),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Check the file' }),
    ).toBeEnabled();
  });

  it('shows an engine failure without blocking the import, and can try again', async () => {
    engine.loadLocalFile.mockRejectedValueOnce(new Error('boom'));
    useImportApi();
    await openPage();
    await chooseFile(csv());
    expect(
      await screen.findByText(/The file could not be checked locally/),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Check the file' }),
    ).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Read 10 rows and 4 columns.'),
    ).toBeVisible();
  });

  it('keeps the findings it has when the duplicate and value checks fail', async () => {
    engine.checkDataset.mockRejectedValue(new Error('closed'));
    useImportApi();
    await openPage();
    await chooseFile(csv());
    expect(
      await screen.findByText('The duplicate and value checks could not run.'),
    ).toBeVisible();
    expect(screen.getByText('colour')).toBeVisible();
  });
});
