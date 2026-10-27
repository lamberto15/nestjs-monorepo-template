import { Table, tableFromJSON } from 'apache-arrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeDataset,
  loadLocalFile,
  queryDataset,
  terminateAnalyticsEngine,
  type AnalyticsDataset,
} from './engine';

// The browser owns DuckDB execution. These tests fake the AsyncDuckDB boundary
// (the package's own class) and check what the engine asks of it: the documented
// start-up, the lock-down statements, the file handle, the SQL, and the lifecycle.

type Gate = { promise: Promise<void>; open(): void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const fakes = vi.hoisted(() => ({
  databases: [] as unknown[],
  workers: [] as string[],
  selected: [] as unknown[],
  failInstantiate: undefined as Error | undefined,
  failures: new Map<string, Error>(),
  version: 'v1.4.3',
}));

type Row = Record<string, unknown>;

class FakeConnection {
  queries: string[] = [];
  gates = new Map<string, Gate>();
  failures = new Map<string, Error>(fakes.failures);
  summary: Row[] = [
    {
      column_name: 'amount',
      column_type: 'BIGINT',
      min: '2',
      max: '10',
      approx_unique: 2,
      count: 4,
      null_percentage: 25,
    },
    {
      column_name: 'details',
      column_type: 'STRUCT(a BIGINT)',
      min: null,
      max: null,
      approx_unique: 3,
      count: 4,
      null_percentage: 0,
    },
  ];
  cancelSent = vi.fn(() => Promise.resolve(true));

  query = vi.fn(async (sql: string): Promise<Table> => {
    this.queries.push(sql);
    for (const [part, failure] of this.failures)
      if (sql.includes(part)) throw failure;
    for (const [part, pending] of this.gates)
      if (sql.includes(part)) await pending.promise;
    if (sql.includes('SUMMARIZE')) return tableFromJSON(this.summary);
    if (sql.startsWith('SELECT version()'))
      return tableFromJSON([{ version: fakes.version }]);
    // The exact null counts, one positional column per profiled column.
    if (sql.startsWith('SELECT count(*) - count('))
      return tableFromJSON([{ n0: 1, n1: 0 }]);
    if (sql.startsWith('SELECT count(*) AS count'))
      return tableFromJSON([{ count: 7 }]);
    if (sql.startsWith('SELECT *'))
      return tableFromJSON([{ amount: 12 }, { amount: 24 }]);
    return new Table();
  });
}

class FakeDatabase {
  connection = new FakeConnection();
  instantiate = vi.fn(async () => {
    if (fakes.failInstantiate) throw fakes.failInstantiate;
  });
  connect = vi.fn(() => Promise.resolve(this.connection));
  registerFileHandle = vi.fn(() => Promise.resolve());
  dropFile = vi.fn(() => Promise.resolve(null));
  terminate = vi.fn(() => Promise.resolve());

  constructor(_logger: unknown, _worker: unknown) {
    fakes.databases.push(this);
  }
}

vi.mock('@duckdb/duckdb-wasm', () => ({
  AsyncDuckDB: FakeDatabase,
  VoidLogger: class {},
  DuckDBDataProtocol: { BROWSER_FILEREADER: 2 },
  selectBundle: vi.fn((bundles: unknown) => {
    fakes.selected.push(bundles);
    return Promise.resolve({
      mainModule: 'eh.wasm',
      mainWorker: 'eh.worker.js',
      pthreadWorker: null,
    });
  }),
}));
vi.mock('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url', () => ({
  default: 'mvp.wasm',
}));
vi.mock('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url', () => ({
  default: 'mvp.worker.js',
}));
vi.mock('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url', () => ({
  default: 'eh.wasm',
}));
vi.mock('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url', () => ({
  default: 'eh.worker.js',
}));

const databases = () => fakes.databases as FakeDatabase[];
const latest = () => databases().at(-1)!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function localFile(name: string, content = 'name,amount\nalpha,2\n') {
  const file = new File([content], name);
  // The engine must hand DuckDB the File itself, never read it into memory.
  const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
  Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
  return { file, arrayBuffer };
}

beforeEach(() => {
  fakes.databases.length = 0;
  fakes.workers.length = 0;
  fakes.selected.length = 0;
  fakes.failInstantiate = undefined;
  fakes.failures.clear();
  fakes.version = 'v1.4.3';
  vi.stubGlobal(
    'Worker',
    class {
      constructor(url: string) {
        fakes.workers.push(url);
      }
    },
  );
});

afterEach(() => {
  terminateAnalyticsEngine();
  vi.unstubAllGlobals();
});

describe('starting DuckDB-Wasm', () => {
  it('selects between the MVP and EH bundles and runs in DuckDB’s own single worker', async () => {
    await loadLocalFile(localFile('sales.csv').file);

    expect(fakes.selected).toEqual([
      {
        mvp: { mainModule: 'mvp.wasm', mainWorker: 'mvp.worker.js' },
        eh: { mainModule: 'eh.wasm', mainWorker: 'eh.worker.js' },
      },
    ]);
    // One worker, the bundle's: there is no outer worker or message protocol.
    expect(fakes.workers).toEqual(['eh.worker.js']);
    expect(databases()).toHaveLength(1);
    expect(latest().instantiate).toHaveBeenCalledWith('eh.wasm', null);
  });

  it('turns off external access and locks the configuration before any file is read', async () => {
    await loadLocalFile(localFile('sales.csv').file);

    expect(latest().connection.queries.slice(0, 9)).toEqual([
      'SELECT version() AS version',
      "SET custom_extension_repository = 'http://localhost:3000/duckdb-extensions'",
      'LOAD json',
      'LOAD parquet',
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      "SET allowed_paths = ['analytics-input.csv', 'analytics-input.json', 'analytics-input.jsonl', 'analytics-input.ndjson', 'analytics-input.parquet']",
      'SET enable_external_access = false',
      'SET lock_configuration = true',
    ]);
    const registered = latest().registerFileHandle.mock.invocationCallOrder[0]!;
    const locked = latest().connection.query.mock.invocationCallOrder[8]!;
    expect(locked).toBeLessThan(registered);
  });

  it('refuses to start when DuckDB-Wasm no longer runs the vendored extensions’ version', async () => {
    fakes.version = 'v1.5.0';

    await expect(loadLocalFile(localFile('sales.csv').file)).rejects.toThrow(
      'vendored extensions are for v1.4.3',
    );
    expect(
      latest().connection.queries.some((sql) => sql.startsWith('LOAD')),
    ).toBe(false);
    expect(latest().terminate).toHaveBeenCalledOnce();
  });

  it('terminates the engine and reports the error when start-up fails', async () => {
    fakes.failInstantiate = new Error('wasm failed to compile');

    await expect(loadLocalFile(localFile('sales.csv').file)).rejects.toThrow(
      'wasm failed to compile',
    );
    expect(latest().terminate).toHaveBeenCalledOnce();

    fakes.failInstantiate = undefined;
    await expect(
      loadLocalFile(localFile('sales.csv').file),
    ).resolves.toMatchObject({ rowCount: 4 });
    expect(databases()).toHaveLength(2);
  });
});

describe('loading a file', () => {
  it.each([
    ['sales.csv', 'analytics-input.csv', "read_csv('analytics-input.csv'"],
    ['SALES.CSV', 'analytics-input.csv', "read_csv('analytics-input.csv'"],
    ['rows.json', 'analytics-input.json', "read_json('analytics-input.json'"],
    [
      'rows.jsonl',
      'analytics-input.jsonl',
      "read_json('analytics-input.jsonl'",
    ],
    [
      'rows.ndjson',
      'analytics-input.ndjson',
      "read_json('analytics-input.ndjson'",
    ],
    [
      'rows.parquet',
      'analytics-input.parquet',
      "read_parquet('analytics-input.parquet'",
    ],
  ])(
    'registers %s as a browser file handle and reads it with DuckDB',
    async (name, virtual, reader) => {
      const { file, arrayBuffer } = localFile(name);

      await loadLocalFile(file);

      expect(latest().registerFileHandle).toHaveBeenCalledWith(
        virtual,
        file,
        2,
        true,
      );
      expect(arrayBuffer).not.toHaveBeenCalled();
      const create = latest().connection.queries.find((sql) =>
        sql.startsWith('CREATE TEMP TABLE'),
      );
      expect(create).toContain(reader);
      expect(create).not.toContain('read_csv_auto');
    },
  );

  it.each([
    ['sales.xlsx', 'Choose a CSV, JSON, JSON Lines, or Parquet file.', 'x'],
    ['', 'Choose a CSV, JSON, JSON Lines, or Parquet file.', 'x'],
    ['sales.csv', 'The selected file is empty.', ''],
  ])(
    'rejects invalid file %j before starting DuckDB',
    async (name, message, content) => {
      await expect(
        loadLocalFile(localFile(name, content).file),
      ).rejects.toThrow(message);
      expect(databases()).toHaveLength(0);
      expect(fakes.workers).toHaveLength(0);
    },
  );

  it('has no size ceiling of its own: a file is never copied into memory', async () => {
    const { file } = localFile('huge.parquet');
    Object.defineProperty(file, 'size', { value: 4 * 1024 ** 3 });

    await expect(loadLocalFile(file)).resolves.toMatchObject({
      name: 'huge.parquet',
    });
  });

  it('counts nulls exactly with one extra statement, not from SUMMARIZE’s rounded percentage', async () => {
    await loadLocalFile(localFile('sales.csv').file);

    const queries = latest().connection.queries;
    expect(queries.filter((sql) => sql.includes('count(*) - count('))).toEqual([
      expect.stringMatching(
        /^SELECT count\(\*\) - count\("amount"\) AS n0, count\(\*\) - count\("details"\) AS n1 FROM "dataset_/,
      ),
    ]);
    expect(queries.join('\n')).not.toContain('null_percentage');
  });

  it('profiles every column with one SUMMARIZE statement', async () => {
    const dataset = await loadLocalFile(localFile('sales.csv').file);

    const queries = latest().connection.queries;
    expect(queries.filter((sql) => sql.includes('SUMMARIZE'))).toHaveLength(1);
    expect(queries.some((sql) => /distinct/i.test(sql))).toBe(false);
    expect(dataset).toEqual({
      id: expect.any(String),
      name: 'sales.csv',
      engineVersion: 'v1.4.3',
      rowCount: 4,
      columns: [
        {
          name: 'amount',
          type: 'BIGINT',
          nullCount: 1,
          distinctCount: 2,
          min: '2',
          max: '10',
        },
        {
          name: 'details',
          type: 'STRUCT(a BIGINT)',
          nullCount: 0,
          distinctCount: 3,
          min: null,
          max: null,
        },
      ],
    });
  });

  it('releases the registered file once the table is materialized', async () => {
    await loadLocalFile(localFile('sales.csv').file);

    expect(latest().dropFile).toHaveBeenCalledWith('analytics-input.csv');
    const queries = latest().connection.queries;
    expect(queries.findIndex((sql) => sql.startsWith('CREATE TEMP'))).toBe(9);
  });

  it.each([
    ['rows.parquet', 'The selected Parquet file is malformed or unsupported.'],
    ['rows.json', 'The selected JSON file is malformed or unsupported.'],
    ['rows.csv', 'Invalid Input Error: unterminated quote'],
  ])(
    'reports a failed read of %s and still releases the file',
    async (name, message) => {
      fakes.failures.set(
        'CREATE TEMP TABLE',
        new Error('Invalid Input Error: unterminated quote'),
      );

      await expect(loadLocalFile(localFile(name).file)).rejects.toThrow(
        message,
      );
      expect(latest().dropFile).toHaveBeenCalledOnce();
    },
  );
});

describe('querying', () => {
  async function load() {
    const dataset: AnalyticsDataset = await loadLocalFile(
      localFile('sales.csv').file,
    );
    return dataset;
  }

  it('runs the generated SQL against the dataset table and returns plain rows', async () => {
    const dataset = await load();

    const result = await queryDataset(dataset, {
      limit: 5,
      filters: [{ column: 'amount', operator: 'gt', value: 10 }],
      sort: { column: 'amount', direction: 'desc' },
    });

    expect(result).toEqual({
      columns: ['amount'],
      rows: [{ amount: 12 }, { amount: 24 }],
      totalRows: 7,
    });
    const queries = latest().connection.queries.slice(-2);
    expect(queries[0]).toMatch(
      /^SELECT count\(\*\) AS count FROM "dataset_[0-9a-f]+" WHERE "amount" > 10$/,
    );
    expect(queries[1]).toMatch(
      /^SELECT \* FROM "dataset_[0-9a-f]+" WHERE "amount" > 10 ORDER BY "amount" DESC NULLS LAST LIMIT 5 OFFSET 0$/,
    );
  });

  it('rejects unknown columns without sending SQL to DuckDB', async () => {
    const dataset = await load();
    const before = latest().connection.queries.length;

    await expect(
      queryDataset(dataset, {
        filters: [{ column: 'missing', operator: 'eq', value: 1 }],
      }),
    ).rejects.toThrow('A filter refers to an unknown column.');
    expect(latest().connection.queries).toHaveLength(before);
  });

  it('rejects a dataset that was never loaded or has been closed', async () => {
    const dataset = await load();
    await expect(queryDataset({ ...dataset, id: 'other' })).rejects.toThrow(
      'The dataset has been closed.',
    );
  });

  it('rejects before any session exists', async () => {
    await expect(
      queryDataset({
        id: 'x',
        name: 'x.csv',
        engineVersion: 'v',
        columns: [],
        rowCount: 0,
      }),
    ).rejects.toThrow('The dataset has been closed.');
    expect(databases()).toHaveLength(0);
  });

  it('runs one operation at a time on the connection', async () => {
    const dataset = await load();
    const hold = gate();
    latest().connection.gates.set('count(*)', hold);

    const first = queryDataset(dataset);
    const second = queryDataset(dataset, { limit: 1 });
    await settle();
    const started = latest().connection.queries.filter((sql) =>
      sql.startsWith('SELECT count(*) AS count'),
    );
    expect(started).toHaveLength(1);

    latest().connection.gates.delete('count(*)');
    hold.open();
    await Promise.all([first, second]);
    expect(
      latest().connection.queries.filter((sql) =>
        sql.startsWith('SELECT count(*) AS count'),
      ),
    ).toHaveLength(2);
  });

  it('keeps working after one query fails', async () => {
    const dataset = await load();
    latest().connection.failures.set('LIMIT 1 ', new Error('Out of memory'));

    await expect(queryDataset(dataset, { limit: 1 })).rejects.toThrow(
      'Out of memory',
    );
    latest().connection.failures.clear();
    await expect(queryDataset(dataset)).resolves.toMatchObject({
      totalRows: 7,
    });
  });
});

describe('disposing and ending the session', () => {
  it('drops the dataset table and forgets the dataset', async () => {
    const dataset = await loadLocalFile(localFile('sales.csv').file);

    await disposeDataset(dataset);

    expect(latest().connection.queries.at(-1)).toMatch(
      /^DROP TABLE IF EXISTS "dataset_[0-9a-f]+"$/,
    );
    await expect(queryDataset(dataset)).rejects.toThrow(
      'The dataset has been closed.',
    );
    expect(latest().terminate).not.toHaveBeenCalled();
  });

  it('ignores disposing when no session exists', async () => {
    await expect(
      disposeDataset({
        id: 'x',
        name: 'x.csv',
        engineVersion: 'v',
        columns: [],
        rowCount: 0,
      }),
    ).resolves.toBeUndefined();
    expect(databases()).toHaveLength(0);
  });

  it('cancels the running query, rejects waiting work and terminates DuckDB', async () => {
    const dataset = await loadLocalFile(localFile('sales.csv').file);
    const hold = gate();
    latest().connection.gates.set('count(*)', hold);
    const first = queryDataset(dataset);
    const second = queryDataset(dataset);
    const rejections = Promise.all([
      expect(first).rejects.toThrow('The local analytics session was closed.'),
      expect(second).rejects.toThrow('The local analytics session was closed.'),
    ]);
    await settle();
    const database = latest();

    terminateAnalyticsEngine();
    await rejections;
    await settle();

    expect(database.connection.cancelSent).toHaveBeenCalledOnce();
    expect(database.terminate).toHaveBeenCalledOnce();
    hold.open();
    await settle();
    // The queued query never reaches DuckDB.
    expect(
      database.connection.queries.filter((sql) =>
        sql.startsWith('SELECT count(*) AS count'),
      ),
    ).toHaveLength(1);
  });

  it('ignores a worker that fails to terminate while closing', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await loadLocalFile(localFile('sales.csv').file);
    latest().terminate.mockRejectedValueOnce(new Error('already gone'));

    terminateAnalyticsEngine();
    await settle();
    await settle();

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('cancels a load that is still starting and ends its engine once it is up', async () => {
    const loading = loadLocalFile(localFile('sales.csv').file);
    const rejection = expect(loading).rejects.toThrow(
      'The local analytics session was closed.',
    );

    terminateAnalyticsEngine();
    await rejection;
    await vi.waitFor(() => expect(databases()).toHaveLength(1));
    await vi.waitFor(() => expect(latest().terminate).toHaveBeenCalledOnce());
    expect(latest().registerFileHandle).not.toHaveBeenCalled();
  });

  it('starts a fresh engine for a replacement import and closes the previous one', async () => {
    const first = await loadLocalFile(localFile('first.csv').file);
    const previous = latest();

    const second = await loadLocalFile(localFile('second.csv').file);
    await settle();

    expect(databases()).toHaveLength(2);
    expect(previous.terminate).toHaveBeenCalledOnce();
    expect(latest().terminate).not.toHaveBeenCalled();
    await expect(queryDataset(first)).rejects.toThrow(
      'The dataset has been closed.',
    );
    await expect(queryDataset(second)).resolves.toMatchObject({ totalRows: 7 });
  });

  it('can start again after the session was terminated', async () => {
    await loadLocalFile(localFile('first.csv').file);
    terminateAnalyticsEngine();
    terminateAnalyticsEngine();

    await expect(
      loadLocalFile(localFile('second.csv').file),
    ).resolves.toMatchObject({ name: 'second.csv' });
    expect(databases()).toHaveLength(2);
  });
});
