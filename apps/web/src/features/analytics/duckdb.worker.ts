import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import {
  boundedPage,
  buildWhereClause,
  quoteIdentifier,
  quoteLiteral,
} from './query';
import type { DatasetQuery } from './engine';
import { jsonRowsToArrow } from './json-table';

type Column = {
  name: string;
  type: string;
  nullCount: number;
  distinctCount: number;
  min: unknown;
  max: unknown;
};
type Dataset = {
  id: string;
  name: string;
  table: string;
  columns: Column[];
  rowCount: number;
};
type Query = DatasetQuery;
type RequestMessage = {
  id: number;
  type: 'load' | 'query' | 'dispose';
  name?: string;
  extension?: string;
  buffer?: ArrayBuffer;
  datasetId?: string;
  query?: Query;
};

const datasets = new Map<string, Dataset>();
let database: duckdb.AsyncDuckDB | undefined;
let connection: duckdb.AsyncDuckDBConnection | undefined;
let initializing: Promise<duckdb.AsyncDuckDBConnection> | undefined;

async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (connection) return connection;
  if (!initializing)
    initializing = (async () => {
      const db = new duckdb.AsyncDuckDB(
        new duckdb.VoidLogger(),
        new Worker(mvpWorker),
      );
      database = db;
      await db.instantiate(mvpWasm);
      await db.open({ maximumThreads: 1 });
      const conn = await db.connect();
      await conn.query('SET autoinstall_known_extensions = false');
      await conn.query('SET autoload_known_extensions = false');
      connection = conn;
      return conn;
    })();
  try {
    return await initializing;
  } finally {
    initializing = undefined;
  }
}

async function resetDatabase() {
  if (database) await database.terminate();
  database = undefined;
  connection = undefined;
  initializing = undefined;
  datasets.clear();
}

function resultRows(table: {
  schema: { fields: { name: string }[] };
  toArray(): Record<string, unknown>[];
}) {
  return {
    columns: table.schema.fields.map((field) => field.name),
    rows: table.toArray().map((row) => Object.fromEntries(Object.entries(row))),
  };
}

function jsonRows(
  buffer: ArrayBuffer,
  extension: string,
): Record<string, unknown>[] {
  const text = new TextDecoder().decode(buffer);
  let parsed: unknown[];
  try {
    if (extension === 'json') {
      const value: unknown = JSON.parse(text);
      parsed = Array.isArray(value) ? value : [value];
    } else {
      parsed = text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
    }
  } catch {
    throw new Error('The selected JSON file is malformed.');
  }
  const rows = parsed.map((value) => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
    return { value };
  });
  return rows;
}

async function load(message: RequestMessage) {
  if (!message.buffer || !message.extension || !message.name)
    throw new Error('The file data is missing.');
  // Each replacement import starts a fresh in-memory database and closes the prior one.
  await resetDatabase();
  const conn = await getConnection();
  const id = crypto.randomUUID();
  const filename = `local_${id}.${message.extension}`;
  const tableName = `dataset_${id.replaceAll('-', '')}`;
  if (message.extension === 'parquet') {
    try {
      // DuckDB's Parquet extension is not bundled with the browser engine. Decode with
      // the locally bundled parquet-wasm module and hand DuckDB an Arrow IPC stream.
      const { parquetToArrowIPC } = await import('./parquet-reader');
      const arrowIPC = await parquetToArrowIPC(message.buffer);
      await conn.insertArrowFromIPCStream(arrowIPC, {
        name: tableName,
        create: true,
      });
    } catch {
      throw new Error('The selected Parquet file is malformed or unsupported.');
    }
  } else if (message.extension === 'csv') {
    await database!.registerFileBuffer(
      filename,
      new Uint8Array(message.buffer),
    );
    try {
      const reader = `read_csv_auto(${quoteLiteral(filename)}, sample_size=-1)`;
      await conn.query(
        `CREATE TEMP TABLE ${quoteIdentifier(tableName)} AS SELECT * FROM ${reader}`,
      );
      // Materialize in memory and release the input buffer. Queries use generated
      // identifiers and never accept SQL or file paths from the page.
      await database!.dropFile(filename);
    } catch (error) {
      await database!.dropFile(filename).catch(() => undefined);
      throw error;
    }
  } else {
    await conn.insertArrowTable(
      jsonRowsToArrow(jsonRows(message.buffer, message.extension)),
      {
        name: tableName,
        create: true,
      },
    );
  }
  const schema = await conn.query(
    `DESCRIBE SELECT * FROM ${quoteIdentifier(tableName)}`,
  );
  const count = await conn.query(
    `SELECT count(*) AS count FROM ${quoteIdentifier(tableName)}`,
  );
  const version = await conn.query('SELECT version() AS version');
  const columns: Column[] = [];
  for (const field of schema.toArray() as Array<Record<string, unknown>>) {
    const name = String(field.column_name);
    const column = quoteIdentifier(name);
    const type = String(field.column_type);
    const comparable =
      /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL(?:\(|$)|BOOLEAN|VARCHAR|CHAR(?:\(|$)|TEXT|DATE|TIME(?:STAMPTZ|TZ)?|TIMESTAMP(?:STAMPTZ|TZ)?)(?:$|\()/i.test(
        type,
      );
    const minMax = comparable
      ? `CAST(min(${column}) AS VARCHAR) AS min, CAST(max(${column}) AS VARCHAR) AS max`
      : 'NULL AS min, NULL AS max';
    const stats = await conn.query(
      `SELECT count(*) FILTER (WHERE ${column} IS NULL) AS null_count, count(DISTINCT ${column}) AS distinct_count, ${minMax} FROM ${quoteIdentifier(tableName)}`,
    );
    const stat = stats.toArray()[0] as Record<string, unknown>;
    columns.push({
      name,
      type,
      nullCount: Number(stat.null_count),
      distinctCount: Number(stat.distinct_count),
      min: stat.min,
      max: stat.max,
    });
  }
  const dataset: Dataset = {
    id,
    name: message.name,
    table: tableName,
    columns,
    rowCount: Number((count.toArray()[0] as Record<string, unknown>).count),
  };
  datasets.set(id, dataset);
  return {
    id,
    name: dataset.name,
    engineVersion: String(
      (version.toArray()[0] as Record<string, unknown>).version,
    ),
    columns,
    rowCount: dataset.rowCount,
  };
}

async function queryDataset(datasetId: string, query: Query = {}) {
  const dataset = datasets.get(datasetId);
  if (!dataset) throw new Error('The dataset has been closed.');
  const allowed = new Set(dataset.columns.map(({ name }) => name));
  const { limit, offset } = boundedPage(query);
  const where = buildWhereClause(query.filters, allowed);
  const table = quoteIdentifier(dataset.table);
  let select = '*';
  let group = '';
  if (query.groupBy || query.aggregate) {
    if (!query.groupBy || !allowed.has(query.groupBy))
      throw new Error('Choose a valid grouping column.');
    const aggregation = query.aggregate;
    if (!aggregation) throw new Error('Choose an aggregate operation.');
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(aggregation.fn))
      throw new Error('Unsupported aggregate operation.');
    const column =
      aggregation.fn === 'count' && !aggregation.column
        ? '*'
        : aggregation.column;
    if (column !== '*' && (!column || !allowed.has(column)))
      throw new Error('Choose a valid aggregate column.');
    select = `${quoteIdentifier(query.groupBy)}, ${aggregation.fn.toUpperCase()}(${column === '*' ? '*' : quoteIdentifier(column)}) AS value`;
    group = ` GROUP BY ${quoteIdentifier(query.groupBy)}`;
  }
  const sortColumn = query.sort?.column;
  const sortable = query.groupBy ? new Set([query.groupBy, 'value']) : allowed;
  if (sortColumn && !sortable.has(sortColumn))
    throw new Error('A sort refers to an unknown column.');
  const order =
    sortColumn && sortable.has(sortColumn)
      ? ` ORDER BY ${quoteIdentifier(sortColumn)} ${query.sort?.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
      : '';
  const conn = await getConnection();
  const total = await conn.query(
    query.groupBy
      ? `SELECT count(*) AS count FROM (SELECT ${quoteIdentifier(query.groupBy)} FROM ${table}${where}${group}) grouped`
      : `SELECT count(*) AS count FROM ${table}${where}`,
  );
  const result = await conn.query(
    `SELECT ${select} FROM ${table}${where}${group}${order} LIMIT ${limit} OFFSET ${offset}`,
  );
  const mapped = resultRows(result);
  return {
    ...mapped,
    totalRows: Number((total.toArray()[0] as Record<string, unknown>).count),
  };
}

async function handleMessage(data: RequestMessage) {
  try {
    let result: unknown;
    if (data.type === 'load') result = await load(data);
    else if (data.type === 'query')
      result = await queryDataset(data.datasetId ?? '', data.query);
    else if (data.type === 'dispose') {
      const dataset = datasets.get(data.datasetId ?? '');
      if (dataset) {
        await (
          await getConnection()
        ).query(`DROP TABLE IF EXISTS ${quoteIdentifier(dataset.table)}`);
        datasets.delete(dataset.id);
      }
    }
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : 'The local query failed.',
    });
  }
}

let messageQueue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<RequestMessage>) => {
  messageQueue = messageQueue.then(() => handleMessage(data));
};
