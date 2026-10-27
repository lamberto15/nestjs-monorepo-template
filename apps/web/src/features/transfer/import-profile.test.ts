import { describe, expect, it } from 'vitest';
import {
  compareImport,
  hasFindings,
  matchColumns,
  NULL_HEAVY_SHARE,
  planChecks,
  type CatalogColumn,
  type FileColumn,
} from './import-profile';

const catalog: CatalogColumn[] = [
  { name: 'sku', type: 'text', required: true },
  { name: 'qty', type: 'number', required: true },
  { name: 'active', type: 'boolean', required: false },
  { name: 'due', type: 'date', required: false },
  { name: 'seenAt', type: 'datetime', required: false },
  { name: 'tags', type: 'list', required: false },
];
const column = (name: string, type: string, nullCount = 0): FileColumn => ({
  name,
  type,
  nullCount,
});
const good = [
  column('sku', 'VARCHAR'),
  column('qty', 'BIGINT'),
  column('active', 'BOOLEAN'),
  column('due', 'DATE'),
  column('seenAt', 'TIMESTAMP'),
];

describe('matching file columns to the catalog', () => {
  it('finds unknown columns and keeps a zoned datetime header', () => {
    const { matches, unknown } = matchColumns(catalog, [
      column('sku', 'VARCHAR'),
      column('seenAt (Asia/Dubai)', 'TIMESTAMP'),
      column('qty (UTC)', 'BIGINT'),
      column('colour', 'VARCHAR'),
    ]);
    expect(matches.map((m) => m.catalog.name)).toEqual(['sku', 'seenAt']);
    expect(unknown).toEqual(['qty (UTC)', 'colour']);
  });

  it('matches a name exactly, with its case', () => {
    expect(matchColumns(catalog, [column('SKU', 'VARCHAR')]).unknown).toEqual([
      'SKU',
    ]);
  });
});

describe('comparing a file with the catalog', () => {
  it('reports nothing for a clean file', () => {
    const findings = compareImport({ catalog, columns: good, rowCount: 10 });
    expect(hasFindings(findings)).toBe(false);
  });

  it('reports missing required columns, not missing optional ones', () => {
    const findings = compareImport({
      catalog,
      columns: [column('active', 'BOOLEAN')],
      rowCount: 3,
    });
    expect(findings.missingRequired).toEqual(['sku', 'qty']);
  });

  it('reports a missing match key', () => {
    const findings = compareImport({
      catalog,
      columns: [column('qty', 'BIGINT')],
      rowCount: 3,
      matchOn: 'sku',
    });
    expect(findings.matchKeyMissing).toBe('sku');
  });

  it.each([
    ['number', 'BOOLEAN', true],
    ['number', 'DATE', true],
    ['number', 'STRUCT(a INTEGER)', true],
    ['number', 'DECIMAL(10,2)', false],
    ['number', 'DOUBLE', false],
    ['boolean', 'DOUBLE', true],
    ['boolean', 'DATE', true],
    ['boolean', 'BIGINT', false],
    ['boolean', 'BOOLEAN', false],
    ['date', 'BIGINT', true],
    ['date', 'BOOLEAN', true],
    ['date', 'TIMESTAMP', false],
    ['datetime', 'DATE', false],
    ['datetime', 'DOUBLE', true],
    ['datetime', 'TIMESTAMP WITH TIME ZONE', false],
    ['text', 'BIGINT', false],
    ['list', 'DATE', false],
    ['string', 'DATE', false],
  ])(
    'catalog %s against detected %s: mismatch %s',
    (expected, detected, bad) => {
      const findings = compareImport({
        catalog: [{ name: 'c', type: expected, required: false }],
        columns: [column('c', detected)],
        rowCount: 5,
      });
      expect(findings.types.length > 0).toBe(bad);
    },
  );

  it('accepts a VARCHAR column unless values fail to parse', () => {
    const base = {
      catalog: [{ name: 'qty', type: 'number', required: false }],
      columns: [column('qty', 'VARCHAR')],
      rowCount: 4,
    };
    expect(compareImport(base).types).toEqual([]);
    expect(
      compareImport({ ...base, checks: { unparseable: { qty: 0 } } }).types,
    ).toEqual([]);
    expect(
      compareImport({ ...base, checks: { unparseable: { qty: 2 } } }).types,
    ).toEqual([
      { column: 'qty', expected: 'number', detected: 'VARCHAR', badValues: 2 },
    ]);
  });

  it('reports duplicate match keys with samples, and none without extra rows', () => {
    const checks = (extraRows: number) => ({
      duplicates: {
        column: 'sku',
        extraRows,
        samples: [{ value: 'A-1', rows: 3 }],
      },
      unparseable: {},
    });
    const input = { catalog, columns: good, rowCount: 9, matchOn: 'sku' };
    expect(compareImport({ ...input, checks: checks(2) }).duplicates).toEqual({
      column: 'sku',
      extraRows: 2,
      samples: ['A-1'],
    });
    expect(compareImport({ ...input, checks: checks(0) }).duplicates).toBe(
      undefined,
    );
  });

  it('flags a required column from the null-heavy threshold on, not below it', () => {
    expect(NULL_HEAVY_SHARE).toBe(0.2);
    const run = (nulls: number) =>
      compareImport({
        catalog,
        columns: [column('sku', 'VARCHAR', nulls), column('qty', 'BIGINT')],
        rowCount: 10,
      }).nullHeavy;
    expect(run(1)).toEqual([]);
    expect(run(2)).toEqual([{ column: 'sku', share: 0.2, nullCount: 2 }]);
    expect(run(10)[0]?.share).toBe(1);
  });

  it('ignores nulls of an optional column and of an empty file', () => {
    const optional = compareImport({
      catalog,
      columns: [...good, column('tags', 'VARCHAR', 9)],
      rowCount: 10,
    });
    expect(optional.nullHeavy).toEqual([]);
    expect(
      compareImport({
        catalog,
        columns: [column('sku', 'VARCHAR', 0)],
        rowCount: 0,
      }).nullHeavy,
    ).toEqual([]);
  });
});

describe('planning the queries', () => {
  it('counts duplicates of the match key and parses VARCHAR columns the catalog types', () => {
    expect(
      planChecks({
        catalog,
        columns: [
          column('sku', 'VARCHAR'),
          column('qty', 'VARCHAR'),
          column('due', 'VARCHAR', 5),
          column('seenAt (Asia/Dubai)', 'VARCHAR'),
          column('active', 'BOOLEAN'),
        ],
        rowCount: 5,
        matchOn: 'sku',
      }),
    ).toEqual({
      duplicateKey: 'sku',
      parse: [
        { column: 'qty', as: 'number' },
        { column: 'seenAt (Asia/Dubai)', as: 'datetime' },
      ],
    });
  });

  it('plans nothing when there is no key and nothing to parse', () => {
    expect(
      planChecks({ catalog, columns: good, rowCount: 5, matchOn: '' }),
    ).toEqual({});
  });

  it('skips a key the file does not have', () => {
    expect(
      planChecks({
        catalog,
        columns: [column('qty', 'BIGINT')],
        rowCount: 1,
        matchOn: 'sku',
      }),
    ).toEqual({});
  });
});
