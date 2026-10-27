import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import extensions from './duckdb-extensions.json';
import {
  buildDatasetSql,
  buildDuplicateKeySql,
  buildParseFailureSql,
  quoteIdentifier,
  quoteLiteral,
  type ParseTarget,
} from './query';

export type AnalyticsColumn = {
  name: string;
  type: string;
  /** Exact: `count(*) - count(column)`, a separate statement because SUMMARIZE only reports a rounded percentage. */
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
  /** Counts of a numeric column in equal-width bins (`bin` = a bin's start, `value` = its count). */
  histogram?: { column: string; bins?: number };
  /** An aggregate per day, week or month of a date or timestamp column (`bucket`, `value`). */
  timeSeries?: { column: string; unit: 'day' | 'week' | 'month' };
};

export type QueryOptions = {
  /**
   * Aborting skips a query that has not started (the queue runs one statement at a
   * time, so superseded queries never reach DuckDB). A running statement cannot be
   * interrupted in the non-pthread build; `terminateAnalyticsEngine()` stops it.
   */
  signal?: AbortSignal;
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
 * Where the page serves DuckDB's official json and parquet extensions from, on its
 * own origin: `<repo>/v<duckdb version>/<platform>/<name>.duckdb_extension.wasm`
 * (public/duckdb-extensions, written by `pnpm duckdb:extensions`; DuckDB-Wasm's
 * documented `custom_extension_repository`:
 * https://duckdb.org/docs/1.4/clients/wasm/extensions.html). The wasm bundles do
 * not link these in (only the Node build does). DuckDB fetches the files itself
 * and checks the signature on LOAD, so unsigned extensions stay refused.
 */
const extensionRepository = () =>
  new URL(
    `${import.meta.env.BASE_URL}duckdb-extensions`,
    globalThis.location.href,
  ).href;

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
    // The vendored extensions are for one DuckDB version. A duckdb-wasm update that
    // moves it must fail here, loudly, instead of requesting files that do not exist.
    const running = String(
      (
        (
          await conn.query('SELECT version() AS version')
        ).toArray()[0] as Record<string, unknown>
      ).version,
    );
    if (running !== `v${extensions.duckdbVersion}`) {
      throw new Error(
        `DuckDB-Wasm runs ${running}, but the vendored extensions are for v${extensions.duckdbVersion}: update duckdbVersion in duckdb-extensions.json and run pnpm duckdb:extensions --record.`,
      );
    }
    // Same-origin repository first, then LOAD (which downloads, verifies the
    // signature and loads); autoinstall and autoload are switched off right after.
    await conn.query(
      `SET custom_extension_repository = ${quoteLiteral(extensionRepository())}`,
    );
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
      void ready
        .then(
          (session) => {
            // Best effort: ask DuckDB to cancel the running query, then end its
            // worker, which frees the engine and its memory either way.
            void session.conn.cancelSent().catch(() => undefined);
            return session.db.terminate();
          },
          () => undefined,
        )
        // Closing is fire and forget: a worker that fails to terminate (already
        // gone, or the session's own failure handler ended it) leaves nothing to
        // clean up, so the rejection is dropped instead of surfacing unhandled.
        .catch(() => undefined);
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
      `SELECT column_name, column_type, min, max, approx_unique, count FROM (SUMMARIZE ${quoteIdentifier(tableName)})`,
    );
    const version = await conn.query('SELECT version() AS version');
    const stats = summary.toArray() as Array<Record<string, unknown>>;
    // SUMMARIZE only has a two-decimal null percentage (1 null in 30,000 rows reads
    // 0), so the exact null counts come from one more statement. Aliases are
    // positional: a column may be named like an Arrow row property.
    const nulls = await conn.query(
      `SELECT ${stats
        .map(
          (stat, index) =>
            `count(*) - count(${quoteIdentifier(String(stat.column_name))}) AS n${index}`,
        )
        .join(', ')} FROM ${quoteIdentifier(tableName)}`,
    );
    let rowCount = 0;
    const columns: AnalyticsColumn[] = stats.map((stat, index) => {
      rowCount = Number(stat.count);
      return {
        name: String(stat.column_name),
        type: String(stat.column_type),
        nullCount: Number(nulls.getChildAt(index)!.get(0)),
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

const abortedError = () =>
  new DOMException('The query was cancelled.', 'AbortError');

export function queryDataset(
  dataset: AnalyticsDataset,
  query: DatasetQuery = {},
  options: QueryOptions = {},
): Promise<QueryResult> {
  if (!current)
    return Promise.reject(new Error('The dataset has been closed.'));
  return run(current, async ({ conn, datasets }) => {
    const info = datasets.get(dataset.id);
    if (!info) throw new Error('The dataset has been closed.');
    if (options.signal?.aborted) throw abortedError();
    const { arrowTableRows } = await import('./arrow-rows');
    if (options.signal?.aborted) throw abortedError();
    const sql = buildDatasetSql(info.table, info.columns, query);
    const total = await conn.query(sql.total);
    if (options.signal?.aborted) throw abortedError();
    const result = await conn.query(sql.rows);
    return {
      ...arrowTableRows(result),
      totalRows: Number((total.toArray()[0] as Record<string, unknown>).count),
    };
  });
}

/** Extra checks of a loaded import file (see `checkDataset`). */
export type DatasetCheckRequest = {
  /** A column whose repeated values are counted (an import's match key). */
  duplicateKey?: string;
  /** Text columns whose values must read as a type; counts the ones that do not. */
  parse?: { column: string; as: ParseTarget }[];
};

export type DatasetChecks = {
  duplicates?: {
    column: string;
    /** Rows whose key already appeared earlier in the file. */
    extraRows: number;
    samples: { value: string; rows: number }[];
  };
  /** Per checked column: the non-empty values that do not read as the type. */
  unparseable: Record<string, number>;
};

/** Duplicate keys and unparseable values of a loaded dataset: bounded, read only. */
export function checkDataset(
  dataset: AnalyticsDataset,
  request: DatasetCheckRequest,
): Promise<DatasetChecks> {
  if (!current)
    return Promise.reject(new Error('The dataset has been closed.'));
  return run(current, async ({ conn, datasets }) => {
    const info = datasets.get(dataset.id);
    if (!info) throw new Error('The dataset has been closed.');
    const checks: DatasetChecks = { unparseable: {} };
    if (request.duplicateKey !== undefined) {
      const sql = buildDuplicateKeySql(
        info.table,
        info.columns,
        request.duplicateKey,
      );
      const count = await conn.query(sql.count);
      const samples = await conn.query(sql.samples);
      checks.duplicates = {
        column: request.duplicateKey,
        extraRows: Number(count.getChildAt(0)!.get(0)),
        samples: (samples.toArray() as Array<Record<string, unknown>>).map(
          (row) => ({ value: String(row.key), rows: Number(row.rows) }),
        ),
      };
    }
    if (request.parse?.length) {
      const result = await conn.query(
        buildParseFailureSql(info.table, info.columns, request.parse),
      );
      request.parse.forEach(({ column }, index) => {
        checks.unparseable[column] = Number(result.getChildAt(index)!.get(0));
      });
    }
    return checks;
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
