import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatasetQuery } from './engine';
import { arrowTableRows } from './arrow-rows';
import {
  buildDatasetSql,
  buildDuplicateKeySql,
  buildParseFailureSql,
} from './query';

// The builders' SQL run by a real DuckDB (the package's Node build, as in
// duckdb-extensions.test.ts), because comparing strings cannot show that a
// column named `bucket` or a NaN in a histogram still binds and executes.

const require = createRequire(
  join(import.meta.dirname, '../../../package.json'),
);

type Conn = {
  query(sql: string): Parameters<typeof arrowTableRows>[0];
  close(): void;
};
let conn: Conn;

beforeAll(async () => {
  const dist = dirname(require.resolve('@duckdb/duckdb-wasm'));
  const node = require(join(dist, 'duckdb-node-blocking.cjs'));
  const db = await node.createDuckDB(
    {
      mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
      eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
    },
    new node.VoidLogger(),
    node.NODE_RUNTIME,
  );
  await db.instantiate(() => undefined);
  db.open({});
  conn = db.connect();
});

afterAll(() => conn?.close());

/** Creates the table, then runs the query the way the engine does. */
function run(setup: string, allowed: string[], query: DatasetQuery) {
  conn.query(`CREATE OR REPLACE TABLE "t" AS ${setup}`);
  const sql = buildDatasetSql('t', new Set(allowed), query);
  const total = Number(
    arrowTableRows(conn.query(sql.total)).rows[0]?.['count'],
  );
  return { total, ...arrowTableRows(conn.query(sql.rows)) };
}

describe('dataset SQL on DuckDB', () => {
  it('buckets a date column of a table that has a column named bucket', () => {
    const result = run(
      `SELECT DATE '2024-01-01' + i::INTEGER AS d, i % 3 AS bucket FROM range(40) r(i)`,
      ['d', 'bucket'],
      { timeSeries: { column: 'd', unit: 'month' } },
    );
    expect(result.columns).toEqual(['bucket', 'value']);
    expect(result.rows).toEqual([
      { bucket: '2024-01-01', value: 31 },
      { bucket: '2024-02-01', value: 9 },
    ]);
  });

  it('sums a column named value over a time series', () => {
    const result = run(
      `SELECT DATE '2024-01-01' + i::INTEGER AS d, i AS "value" FROM range(4) r(i)`,
      ['d', 'value'],
      {
        timeSeries: { column: 'd', unit: 'day' },
        aggregate: { fn: 'sum', column: 'value' },
      },
    );
    expect(result.rows.map((row) => row['value'])).toEqual([0, 1, 2, 3]);
  });

  it('groups by a column named value without losing the key or the aggregate', () => {
    const result = run(
      `SELECT i % 3 AS "value", i AS n FROM range(10) r(i)`,
      ['value', 'n'],
      {
        groupBy: 'value',
        aggregate: { fn: 'sum', column: 'n' },
        sort: { column: 'value', direction: 'desc' },
      },
    );
    expect(result.columns).toEqual(['value (group)', 'value']);
    expect(result.rows).toEqual(
      [
        { 'value (group)': 0, value: 18 },
        { 'value (group)': 1, value: 12 },
        { 'value (group)': 2, value: 15 },
      ].sort((a, b) => b.value - a.value),
    );
    expect(result.total).toBe(3);
  });

  it('sorts a grouping by its key or its aggregate when a table column is called value', () => {
    const table = `SELECT i % 3 AS g, i AS "value" FROM range(10) r(i)`;
    const byValue = run(table, ['g', 'value'], {
      groupBy: 'g',
      aggregate: { fn: 'sum', column: 'value' },
      sort: { column: 'value', direction: 'asc' },
    });
    expect(byValue.rows.map((row) => row['value'])).toEqual([12, 15, 18]);
    const byKey = run(table, ['g', 'value'], {
      groupBy: 'g',
      aggregate: { fn: 'sum', column: 'value' },
      sort: { column: 'g', direction: 'desc' },
    });
    expect(byKey.rows.map((row) => row['g'])).toEqual([2, 1, 0]);
  });

  it.each([
    ['NaN', `VALUES (1.0::DOUBLE), (2.0), ('nan'::DOUBLE)`, 2],
    ['Infinity', `VALUES (1.0::DOUBLE), (2.0), ('inf'::DOUBLE)`, 2],
    ['-Infinity', `VALUES (1.0::DOUBLE), ('-inf'::DOUBLE), (3.0)`, 2],
    ['the whole DOUBLE range', `VALUES (-1.7e308::DOUBLE), (1.7e308)`, 2],
  ])('bins a column with %s', (_, values, finite) => {
    const result = run(`SELECT * FROM (${values}) r(v)`, ['v'], {
      histogram: { column: 'v', bins: 4 },
    });
    const counts = result.rows.map((row) => Number(row['value']));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(finite);
    for (const row of result.rows)
      expect(Number.isFinite(row['bin'])).toBe(true);
  });

  it('puts the maximum into the last bin, and one distinct value into bin 0', () => {
    const spread = run(`SELECT i::INTEGER AS v FROM range(11) r(i)`, ['v'], {
      histogram: { column: 'v', bins: 5 },
    });
    expect(spread.rows).toEqual([
      { bin: 0, value: 2 },
      { bin: 2, value: 2 },
      { bin: 4, value: 2 },
      { bin: 6, value: 2 },
      { bin: 8, value: 3 },
    ]);
    const one = run(`SELECT 7 AS v FROM range(5)`, ['v'], {
      histogram: { column: 'v' },
    });
    expect(one.rows).toEqual([{ bin: 7, value: 5 }]);
  });

  it('uses the default bins for a NaN bin count and yields no bins without finite values', () => {
    const nan = run(`SELECT i::INTEGER AS v FROM range(100) r(i)`, ['v'], {
      histogram: { column: 'v', bins: Number.NaN },
    });
    expect(nan.total).toBe(20);
    const none = run(`SELECT 'nan'::DOUBLE AS v`, ['v'], {
      histogram: { column: 'v' },
    });
    expect(none.rows).toEqual([]);
  });

  it('returns numbers for MIN and MAX of a DECIMAL column, grouped and over time', () => {
    const setup = `SELECT DATE '2024-01-01' + i::INTEGER AS d, (i % 2)::VARCHAR AS g, (100 + i * 25)::DECIMAL(10, 2) AS price FROM range(4) r(i)`;
    for (const fn of ['min', 'max'] as const) {
      const grouped = run(setup, ['d', 'g', 'price'], {
        groupBy: 'g',
        aggregate: { fn, column: 'price' },
        sort: { column: 'value', direction: 'asc' },
      });
      for (const row of grouped.rows)
        expect(typeof row['value']).toBe('number');
      const series = run(setup, ['d', 'g', 'price'], {
        timeSeries: { column: 'd', unit: 'month' },
        aggregate: { fn, column: 'price' },
      });
      expect(series.rows).toEqual([
        { bucket: '2024-01-01', value: fn === 'min' ? 100 : 175 },
      ]);
    }
  });

  it('executes column names with quotes, apostrophes and newlines', () => {
    const name = `a"b'c\nd`;
    const setup = `SELECT 1.5 AS "a""b'c
d", DATE '2024-03-05' AS "when"`;
    const allowed = [name, 'when'];
    expect(
      run(setup, allowed, { histogram: { column: name } }).rows,
    ).toHaveLength(1);
    const grouped = run(setup, allowed, {
      groupBy: name,
      aggregate: { fn: 'max', column: name },
      sort: { column: name, direction: 'asc' },
      filters: [{ column: name, operator: 'contains', value: `'; DROP --` }],
    });
    expect(grouped.rows).toEqual([]);
    expect(
      run(setup, allowed, {
        timeSeries: { column: 'when', unit: 'week' },
        aggregate: { fn: 'sum', column: name },
      }).rows,
    ).toEqual([{ bucket: '2024-03-04', value: 1.5 }]);
  });
});

describe('import profiling SQL on DuckDB', () => {
  const rows = (sql: string) => arrowTableRows(conn.query(sql)).rows;

  it('counts repeated keys, ignoring empty ones, and lists the most repeated', () => {
    conn.query(
      `CREATE OR REPLACE TABLE "t" AS SELECT * FROM (VALUES ('a'), ('b'), ('a'), (NULL), (NULL), ('c'), ('a'), ('b')) v(sku)`,
    );
    const sql = buildDuplicateKeySql('t', new Set(['sku']), 'sku');
    expect(rows(sql.count)).toEqual([{ extra: 3 }]);
    expect(rows(sql.samples)).toEqual([
      { key: 'a', rows: 3 },
      { key: 'b', rows: 2 },
    ]);
  });

  it('bounds the sample list and handles a key named like an alias', () => {
    conn.query(
      `CREATE OR REPLACE TABLE "t" AS SELECT (i // 2)::VARCHAR AS "rows" FROM range(30) r(i)`,
    );
    const sql = buildDuplicateKeySql('t', new Set(['rows']), 'rows');
    expect(rows(sql.count)).toEqual([{ extra: 15 }]);
    expect(rows(sql.samples)).toHaveLength(5);
  });

  it('counts the values of a text column that do not read as the type', () => {
    conn.query(
      `CREATE OR REPLACE TABLE "t" AS SELECT * FROM (VALUES ('1', '2024-01-31', '2026-10-15T18:30:00+04:00', 'true'), ('x', '31/01/2024', '2026-10-15 18:30:00', 'maybe'), (NULL, NULL, NULL, NULL), ('2.5', 'soon', 'later', 'false')) v(n, d, dt, b)`,
    );
    const sql = buildParseFailureSql('t', new Set(['n', 'd', 'dt', 'b']), [
      { column: 'n', as: 'number' },
      { column: 'd', as: 'date' },
      { column: 'dt', as: 'datetime' },
      { column: 'b', as: 'boolean' },
    ]);
    expect(rows(sql)).toEqual([{ n0: 1, n1: 2, n2: 1, n3: 1 }]);
  });
});
