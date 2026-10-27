import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildDuplicateKeySql,
  buildImportReaderSql,
  buildParseFailureSql,
  buildRawHeaderSql,
  importValueSql,
  quoteIdentifier,
  quoteLiteral,
} from '../analytics/query';
import type { DatasetChecks } from '../analytics/engine';
import {
  compareImport,
  planChecks,
  type CatalogColumn,
  type FileColumn,
} from './import-profile';

// Real files through DuckDB's Node build (as query.duckdb.test.ts): the same
// reader, header, null-count and check statements `loadLocalFile` and
// `checkDataset` send, then `compareImport`. What each case asserts is what the
// import server does with the same text (apps/api platform/data-transfer).

const require = createRequire(
  join(import.meta.dirname, '../../../package.json'),
);

type Row = { toJSON(): Record<string, unknown> };
type Table = {
  toArray(): Row[];
  getChildAt(index: number): { get(row: number): unknown } | null;
  schema: { fields: unknown[] };
};
type Db = { registerFileText(name: string, text: string): void };
let db: Db;
let conn: { query(sql: string): Table; close(): void };

beforeAll(async () => {
  // jsdom defines XMLHttpRequest, which makes the Node build try to download
  // its JSON extension instead of using the one it embeds.
  vi.stubGlobal('XMLHttpRequest', undefined);
  const dist = dirname(require.resolve('@duckdb/duckdb-wasm'));
  const node = require(join(dist, 'duckdb-node-blocking.cjs'));
  const instance = await node.createDuckDB(
    {
      mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
      eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
    },
    new node.VoidLogger(),
    node.NODE_RUNTIME,
  );
  await instance.instantiate(() => undefined);
  instance.open({});
  db = instance;
  conn = instance.connect();
});

afterAll(() => {
  conn?.close();
  vi.unstubAllGlobals();
});

const rows = (sql: string) =>
  conn.query(sql).toArray() as unknown as Record<string, unknown>[];

/** What the import check does with a file, end to end. */
function check(input: {
  file: string;
  text: string;
  catalog: CatalogColumn[];
  matchOn?: string;
  matchKeys?: string[];
}) {
  const extension = input.file.endsWith('.json') ? 'json' : 'csv';
  db.registerFileText(input.file, input.text);
  const source = quoteLiteral(input.file);
  conn.query(
    `CREATE OR REPLACE TABLE "t" AS SELECT * FROM ${buildImportReaderSql(extension, source)}`,
  );
  let raw: string[] | undefined;
  if (extension === 'csv') {
    const header = conn.query(buildRawHeaderSql(source));
    raw = header.schema.fields.map((_, index) =>
      String(header.getChildAt(index)!.get(0)).trim(),
    );
  }
  const stats = rows(`SELECT column_name, column_type FROM (SUMMARIZE "t")`);
  const rowCount = Number(rows(`SELECT count(*) AS n FROM "t"`)[0]!['n']);
  const nulls = conn.query(
    `SELECT ${stats
      .map(
        (stat, index) =>
          `count(*) - count(${importValueSql(quoteIdentifier(String(stat['column_name'])), stat['column_type'] === 'JSON')}) AS n${index}`,
      )
      .join(', ')} FROM "t"`,
  );
  const columns: FileColumn[] = stats.map((stat, index) => ({
    name: String(stat['column_name']),
    type: String(stat['column_type']),
    nullCount: Number(nulls.getChildAt(index)!.get(0)),
    ...(raw && raw[index] && raw[index] !== stat['column_name']
      ? { header: raw[index] }
      : {}),
  }));
  const common = {
    catalog: input.catalog,
    columns,
    rowCount,
    matchOn: input.matchOn,
    matchKeys: input.matchKeys,
  };
  const request = planChecks(common);
  const allowed = new Set(columns.map(({ name }) => name));
  const checks: DatasetChecks = { unparseable: {} };
  if (request.duplicateKey) {
    const sql = buildDuplicateKeySql('t', allowed, request.duplicateKey);
    checks.duplicates = {
      column: request.duplicateKey,
      extraRows: Number(rows(sql.count)[0]!['extra']),
      samples: rows(sql.samples).map((row) => ({
        value: String(row['key']),
        rows: Number(row['rows']),
      })),
    };
  }
  if (request.parse?.length) {
    const counted = conn.query(
      buildParseFailureSql('t', allowed, request.parse),
    );
    request.parse.forEach(({ column }, index) => {
      checks.unparseable[column] = Number(counted.getChildAt(index)!.get(0));
    });
  }
  return { columns, findings: compareImport({ ...common, checks }) };
}

const col = (
  name: string,
  type: CatalogColumn['type'],
  required = false,
): CatalogColumn => ({ name, type, required });

describe('an import file read like the server reads it', () => {
  it('takes the match key of a notes-shaped catalog from the header, not the columns', () => {
    const { findings } = check({
      file: 'notes.csv',
      text: 'id,title\n7,a\n7,b\n8,c\n',
      catalog: [col('title', 'text', true), col('body', 'text')],
      matchOn: 'id',
      matchKeys: ['id', 'number'],
    });
    expect(findings.matchKeyMissing).toBeUndefined();
    expect(findings.unknown).toEqual([]);
    expect(findings.duplicates).toEqual({
      column: 'id',
      extraRows: 1,
      samples: ['7'],
    });
  });

  it('compares a key trimmed, and ignores blank keys', () => {
    const { findings } = check({
      file: 'keys.csv',
      text: 'id,title\n 7 ,a\n7,b\n  ,c\n  ,d\n',
      catalog: [col('title', 'text')],
      matchOn: 'id',
      matchKeys: ['id'],
    });
    expect(findings.duplicates?.extraRows).toBe(1);
  });

  it('refuses dates the server refuses, though DuckDB types them as DATE', () => {
    const csv =
      'due,at\n2024-01-31,2026-10-15 18:30\n31/01/2024,2026-10-15T18:30:00+04:00\n01/31/2024,15/10/2026 18:30\n2024-02-30,2026-10-15\n';
    const { columns, findings } = check({
      file: 'dates.csv',
      text: csv,
      catalog: [col('due', 'date'), col('at', 'datetime')],
    });
    expect(columns.map((c) => c.type)).toEqual(['VARCHAR', 'VARCHAR']);
    expect(findings.types).toEqual([
      { column: 'due', expected: 'date', detected: 'VARCHAR', badValues: 3 },
      { column: 'at', expected: 'datetime', detected: 'VARCHAR', badValues: 2 },
    ]);
  });

  it('refuses a column of day/month/year dates that DuckDB types as DATE', () => {
    const { findings } = check({
      file: 'dmy.csv',
      text: 'due\n31/01/2024\n15/03/2024\n',
      catalog: [col('due', 'date')],
    });
    expect(findings.types).toEqual([
      { column: 'due', expected: 'date', detected: 'VARCHAR', badValues: 2 },
    ]);
  });

  it('takes an ISO timestamp in a date column, as the server cuts it to the day', () => {
    const { findings } = check({
      file: 'iso.csv',
      text: 'due\n2024-01-31T10:00:00Z\n2024-01-31\n',
      catalog: [col('due', 'date')],
    });
    expect(findings.types).toEqual([]);
  });

  it('refuses JSON Lines, which only the explorer reads', () => {
    db.registerFileText('lines.json', '{"qty":1}\n{"qty":2}\n');
    expect(() =>
      conn.query(
        `SELECT * FROM ${buildImportReaderSql('json', quoteLiteral('lines.json'))}`,
      ),
    ).toThrow(/top-level JSON array/);
    // ... and a JSON array reads.
    const { findings } = check({
      file: 'array.json',
      text: '[{"qty":1},{"qty":2}]',
      catalog: [col('qty', 'number')],
    });
    expect(findings.types).toEqual([]);
  });

  it('judges a JSON column of strings and numbers by its values', () => {
    const catalog = [col('n', 'number')];
    const mixed = check({
      file: 'mixed.json',
      text: '[{"n":"12"},{"n":5},{"n":" 7 "}]',
      catalog,
    });
    expect(mixed.columns[0]!.type).toBe('JSON');
    expect(mixed.findings.types).toEqual([]);
    const bad = check({
      file: 'mixed-bad.json',
      text: '[{"n":"12"},{"n":5},{"n":"x"}]',
      catalog,
    });
    expect(bad.findings.types).toEqual([
      { column: 'n', expected: 'number', detected: 'JSON', badValues: 1 },
    ]);
  });

  it('trims values and takes the server vocabulary for booleans', () => {
    const { columns, findings } = check({
      file: 'bools.csv',
      text: 'active,qty\n true ,12\nYes,\t3 \nNO,   \n1,4\nmaybe,x\n',
      catalog: [col('active', 'boolean'), col('qty', 'number', true)],
    });
    expect(columns.find((c) => c.name === 'qty')!.nullCount).toBe(1);
    expect(findings.types).toEqual([
      {
        column: 'active',
        expected: 'boolean',
        detected: 'VARCHAR',
        badValues: 1,
      },
      { column: 'qty', expected: 'number', detected: 'VARCHAR', badValues: 1 },
    ]);
  });

  it('keeps case variants apart and reports a header the file repeats', () => {
    const { columns, findings } = check({
      file: 'headers.csv',
      text: 'Name,name,a,a\nx,y,1,2\n',
      catalog: [
        col('Name', 'text', true),
        col('name', 'text'),
        col('a', 'number'),
      ],
    });
    // DuckDB's own names, kept for the queries.
    expect(columns.map((c) => c.name)).toEqual(['Name', 'name_1', 'a', 'a_1']);
    expect(findings.unknown).toEqual([]);
    expect(findings.missingRequired).toEqual([]);
    expect(findings.repeatedHeaders).toEqual(['a']);
  });
});
