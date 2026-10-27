import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { arrowTableRows } from './arrow-rows';
import { buildDatasetSql, quoteIdentifier, quoteLiteral } from './query';

export type AnalyticsColumn = {
  name: string;
  type: string;
  /** Rounded from SUMMARIZE's null percentage (two decimals): approximate on very large tables. */
  nullCount: number;
  /** SUMMARIZE's `approx_unique` (HyperLogLog), not an exact count. */
  distinctCount: number;
  min: unknown;
  max: unknown;
};

export type AnalyticsDataset = {
  id: string;
  name: string;
  engineVersion: string;
  columns: AnalyticsColumn[];
  rowCount: number;
};

export type DatasetFilter = {
  column: string;
  operator:
    | 'eq'
    | 'neq'
    | 'contains'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'isNull'
    | 'isNotNull';
  value?: string | number | boolean | null;
};

export type DatasetQuery = {
  offset?: number;
  limit?: number;
  filters?: DatasetFilter[];
  sort?: { column: string; direction: 'asc' | 'desc' };
  groupBy?: string;
  aggregate?: { column?: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max' };
};

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
};

const EXTENSIONS = ['csv', 'json', 'jsonl', 'ndjson', 'parquet'] as const;
type Extension = (typeof EXTENSIONS)[number];

// Fixed names in DuckDB's virtual file system. `allowed_paths` is locked before any
// file is registered, so the names must be known up front; only these are readable.
const inputName = (extension: Extension) => `analytics-input.${extension}`;

const closedError = () => new Error('The local analytics session was closed.');

type TableInfo = { table: string; columns: Set<string> };
type Session = {
  db: AsyncDuckDB;
  conn: AsyncDuckDBConnection;
  datasets: Map<string, TableInfo>;
  queue: Promise<unknown>;
};
type Handle = {
  ready: Promise<Session>;
  /** Rejects every waiting operation once the handle is closed. */
  aborted: Promise<never>;
  closed: boolean;
  close(): void;
};

let current: Handle | undefined;

/**
 * DuckDB-Wasm the way its README documents for Vite: the package and the `?url`
 * wasm and worker files of the MVP and EH bundles load lazily (dynamic `import()`,
 * so none of it is in the entry chunk), `selectBundle` picks one by browser
 * features, and `AsyncDuckDB` drives DuckDB's own worker. No worker of our own.
 */
async function openSession(): Promise<Session> {
  const [duckdb, mvpWasm, mvpWorker, ehWasm, ehWorker] = await Promise.all([
    import('@duckdb/duckdb-wasm'),
    import('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'),
    import('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'),
    import('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'),
    import('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'),
  ]);
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm.default, mainWorker: mvpWorker.default },
    eh: { mainModule: ehWasm.default, mainWorker: ehWorker.default },
  });
  const db = new duckdb.AsyncDuckDB(
    new duckdb.VoidLogger(),
    new Worker(bundle.mainWorker!),
  );
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    // json and parquet are linked into the wasm build, so LOAD needs no download.
    // Load them first: autoload is switched off right after.
    await conn.query('LOAD json');
    await conn.query('LOAD parquet');
    await conn.query('SET autoinstall_known_extensions = false');
    await conn.query('SET autoload_known_extensions = false');
    // With external access off DuckDB refuses every file that is not allow-listed,
    // registered ones included (checked against 1.32.0). Allow only the fixed
    // virtual names, so no remote URL, extension or other file is readable.
    await conn.query(
      `SET allowed_paths = [${EXTENSIONS.map((e) => quoteLiteral(inputName(e))).join(', ')}]`,
    );
    await conn.query('SET enable_external_access = false');
    await conn.query('SET lock_configuration = true');
    return { db, conn, datasets: new Map(), queue: Promise.resolve() };
  } catch (error) {
    await db.terminate();
    throw error;
  }
}

function startSession(): Handle {
  let abort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });
  aborted.catch(() => undefined);
  const ready = openSession();
  ready.catch(() => undefined);
  const handle: Handle = {
    ready,
    aborted,
    closed: false,
    close() {
      if (handle.closed) return;
      handle.closed = true;
      abort(closedError());
      void ready.then(
        (session) => {
          // Best effort: ask DuckDB to cancel the running query, then end its
          // worker, which frees the engine and its memory either way.
          void session.conn.cancelSent().catch(() => undefined);
          return session.db.terminate();
        },
        () => undefined,
      );
    },
  };
  return handle;
}

/** Operations on one session run one at a time, as one DuckDB connection expects. */
function run<T>(
  handle: Handle,
  task: (session: Session) => Promise<T>,
): Promise<T> {
  const result = handle.ready.then((session) => {
    const next = session.queue.then(() => {
      if (handle.closed) throw closedError();
      return task(session);
    });
    session.queue = next.catch(() => undefined);
    return next;
  });
  return Promise.race([result, handle.aborted]);
}

function describeFailure(extension: Extension, error: unknown): Error {
  if (extension === 'csv') return error as Error;
  const kind = extension === 'parquet' ? 'Parquet' : 'JSON';
  return new Error(`The selected ${kind} file is malformed or unsupported.`, {
    cause: error,
  });
}

/** Loads supported files in DuckDB-Wasm's own browser worker, without copying them. */
export async function loadLocalFile(file: File): Promise<AnalyticsDataset> {
  const extension = file.name.split('.').pop()?.toLowerCase() as
    Extension | undefined;
  if (!extension || !EXTENSIONS.includes(extension)) {
    throw new Error('Choose a CSV, JSON, JSON Lines, or Parquet file.');
  }
  if (file.size === 0) throw new Error('The selected file is empty.');

  // Each replacement import starts a fresh engine: wasm memory never shrinks, so
  // dropping the table would not give a large file's memory back.
  current?.close();
  const handle = startSession();
  current = handle;

  return run(handle, async ({ db, conn, datasets }) => {
    const duckdb = await import('@duckdb/duckdb-wasm');
    const id = crypto.randomUUID();
    const filename = inputName(extension);
    const tableName = `dataset_${id.replaceAll('-', '')}`;
    // DuckDB reads the File in slices (BROWSER_FILEREADER, direct I/O): its
    // bytes are never copied into the JavaScript heap.
    await db.registerFileHandle(
      filename,
      file,
      duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
      true,
    );
    const source = quoteLiteral(filename);
    const reader =
      extension === 'parquet'
        ? `read_parquet(${source})`
        : extension === 'csv'
          ? `read_csv(${source}, sample_size = -1)`
          : // Detects a JSON array, newline-delimited JSON and nested values.
            `read_json(${source}, sample_size = -1)`;
    try {
      // Materialize once: queries are then fast and the file can be released.
      await conn.query(
        `CREATE TEMP TABLE ${quoteIdentifier(tableName)} AS SELECT * FROM ${reader}`,
      );
    } catch (error) {
      throw describeFailure(extension, error);
    } finally {
      await db.dropFile(filename).catch(() => undefined);
    }
    // One statement profiles every column (min, max, approx_unique, null share).
    const summary = await conn.query(
      `SELECT column_name, column_type, min, max, approx_unique, count, CAST(null_percentage AS DOUBLE) AS null_percentage FROM (SUMMARIZE ${quoteIdentifier(tableName)})`,
    );
    const version = await conn.query('SELECT version() AS version');
    let rowCount = 0;
    const columns: AnalyticsColumn[] = (
      summary.toArray() as Array<Record<string, unknown>>
    ).map((stat) => {
      rowCount = Number(stat.count);
      return {
        name: String(stat.column_name),
        type: String(stat.column_type),
        nullCount: Math.round((rowCount * Number(stat.null_percentage)) / 100),
        distinctCount: Number(stat.approx_unique),
        min: stat.min ?? null,
        max: stat.max ?? null,
      };
    });
    datasets.set(id, {
      table: tableName,
      columns: new Set(columns.map(({ name }) => name)),
    });
    return {
      id,
      name: file.name,
      engineVersion: String(
        (version.toArray()[0] as Record<string, unknown>).version,
      ),
      columns,
      rowCount,
    };
  });
}

export function queryDataset(
  dataset: AnalyticsDataset,
  query: DatasetQuery = {},
): Promise<QueryResult> {
  if (!current)
    return Promise.reject(new Error('The dataset has been closed.'));
  return run(current, async ({ conn, datasets }) => {
    const info = datasets.get(dataset.id);
    if (!info) throw new Error('The dataset has been closed.');
    const sql = buildDatasetSql(info.table, info.columns, query);
    const total = await conn.query(sql.total);
    const result = await conn.query(sql.rows);
    return {
      ...arrowTableRows(result),
      totalRows: Number((total.toArray()[0] as Record<string, unknown>).count),
    };
  });
}

export async function disposeDataset(dataset: AnalyticsDataset): Promise<void> {
  if (!current) return;
  await run(current, async ({ conn, datasets }) => {
    const info = datasets.get(dataset.id);
    if (!info) return;
    await conn.query(`DROP TABLE IF EXISTS ${quoteIdentifier(info.table)}`);
    datasets.delete(dataset.id);
  });
}

/** Cancels in-flight local queries and releases DuckDB's worker and memory. */
export function terminateAnalyticsEngine(): void {
  current?.close();
  current = undefined;
}
