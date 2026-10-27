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

  it('reads a parenthesis as a zone only when it is a time zone, as the server does', () => {
    const { matches, unknown } = matchColumns(catalog, [
      column('seenAt (Europe/Berlin)', 'TIMESTAMP'),
      column('seenAt (Mars/Olympus)', 'TIMESTAMP'),
      column('seenAt (local time)', 'TIMESTAMP'),
    ]);
    expect(matches.map((m) => m.file.name)).toEqual(['seenAt (Europe/Berlin)']);
    expect(unknown).toEqual(['seenAt (Mars/Olympus)', 'seenAt (local time)']);
  });

  it('does not call a match key unknown, though the catalog has no such column', () => {
    expect(
      matchColumns(
        catalog,
        [column('id', 'VARCHAR'), column('x', 'VARCHAR')],
        ['id', 'number'],
      ).unknown,
    ).toEqual(['x']);
  });

  it('matches by the header the file spells, and reports a repeated one once', () => {
    const { matches, unknown, repeated } = matchColumns(catalog, [
      column('sku', 'VARCHAR'),
      { ...column('sku_1', 'VARCHAR'), header: 'sku' },
      { ...column('sku_2', 'VARCHAR'), header: 'sku' },
      { ...column('Qty_1', 'VARCHAR'), header: 'qty' },
    ]);
    expect(matches.map((m) => m.file.name)).toEqual(['sku', 'Qty_1']);
    expect(unknown).toEqual([]);
    expect(repeated).toEqual(['sku']);
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

describe('a match key that is not a catalog column (notes: id, number)', () => {
  const notes: CatalogColumn[] = [
    { name: 'title', type: 'text', required: true },
    { name: 'body', type: 'text', required: false },
  ];
  const file = [column('id', 'VARCHAR'), column('title', 'VARCHAR')];
  const input = {
    catalog: notes,
    columns: file,
    rowCount: 4,
    matchOn: 'id',
    matchKeys: ['id', 'number'],
  };

  it('is found in the file, not reported missing or unknown', () => {
    const findings = compareImport(input);
    expect(findings.matchKeyMissing).toBeUndefined();
    expect(findings.unknown).toEqual([]);
    expect(hasFindings(findings)).toBe(false);
  });

  it('still reports a key the file lacks, by its header', () => {
    expect(compareImport({ ...input, matchOn: 'number' }).matchKeyMissing).toBe(
      'number',
    );
    expect(
      compareImport({
        ...input,
        columns: [{ ...file[0]!, name: 'id_1', header: 'id' }, file[1]!],
      }).matchKeyMissing,
    ).toBeUndefined();
  });

  it('plans the duplicate count on the key column, by the name DuckDB gave it', () => {
    expect(planChecks(input)).toEqual({ duplicateKey: 'id' });
    expect(
      planChecks({
        ...input,
        columns: [{ ...file[0]!, name: 'id_1', header: 'id' }, file[1]!],
      }),
    ).toEqual({ duplicateKey: 'id_1' });
  });
});

describe('a JSON column of mixed strings and numbers', () => {
  const quantities: CatalogColumn[] = [
    { name: 'qty', type: 'number', required: false },
  ];

  it('is judged by its values, never by the type JSON', () => {
    const columns = [column('qty', 'JSON')];
    expect(
      compareImport({ catalog: quantities, columns, rowCount: 3 }).types,
    ).toEqual([]);
    expect(planChecks({ catalog: quantities, columns, rowCount: 3 })).toEqual({
      parse: [{ column: 'qty', as: 'number', json: true }],
    });
    expect(
      compareImport({
        catalog: quantities,
        columns,
        rowCount: 3,
        checks: { unparseable: { qty: 1 } },
      }).types,
    ).toEqual([
      { column: 'qty', expected: 'number', detected: 'JSON', badValues: 1 },
    ]);
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
