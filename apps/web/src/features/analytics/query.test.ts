import { describe, expect, it } from 'vitest';
import type { DatasetFilter, DatasetQuery } from './engine';
import {
  boundedPage,
  buildDatasetSql,
  buildWhereClause,
  quoteIdentifier,
} from './query';

describe('local analytics query helpers', () => {
  it('quotes hostile identifiers and string values', () => {
    expect(quoteIdentifier('name"; DROP TABLE x; --')).toBe(
      '"name""; DROP TABLE x; --"',
    );
    expect(
      buildWhereClause(
        [
          {
            column: 'name"; DROP TABLE x; --',
            operator: 'eq',
            value: "x' OR 1=1 --",
          },
        ],
        new Set(['name"; DROP TABLE x; --']),
      ),
    ).toBe(' WHERE "name""; DROP TABLE x; --" = \'x\'\' OR 1=1 --\'');
  });

  it('escapes LIKE metacharacters and rejects unknown columns/operators', () => {
    expect(
      buildWhereClause(
        [{ column: 'label', operator: 'contains', value: "50%_'" }],
        new Set(['label']),
      ),
    ).toBe(
      " WHERE CAST(\"label\" AS VARCHAR) ILIKE '%50\\%\\_''%' ESCAPE '\\'",
    );
    expect(() =>
      buildWhereClause(
        [{ column: 'secret', operator: 'eq', value: 'x' }],
        new Set(['name']),
      ),
    ).toThrow('unknown column');
    const maliciousOperator = {
      column: 'name',
      operator: 'delete;--',
      value: 'x',
    } as unknown as DatasetFilter;
    expect(() =>
      buildWhereClause([maliciousOperator], new Set(['name'])),
    ).toThrow('Unsupported filter');
  });

  it('bounds pages even when the caller asks for excessive ranges', () => {
    expect(boundedPage({ limit: 9_000, offset: 99_000_000 })).toEqual({
      limit: 500,
      offset: 10_000_000,
    });
    expect(boundedPage({ limit: -2, offset: -4 })).toEqual({
      limit: 1,
      offset: 0,
    });
  });

  describe('buildDatasetSql', () => {
    const columns = new Set(['region', 'amount']);

    it('selects a bounded, filtered and sorted page with a matching total', () => {
      expect(
        buildDatasetSql('t', columns, {
          limit: 9_000,
          offset: 20,
          filters: [{ column: 'amount', operator: 'gte', value: 3 }],
          sort: { column: 'amount', direction: 'desc' },
        }),
      ).toEqual({
        total: 'SELECT count(*) AS count FROM "t" WHERE "amount" >= 3',
        rows: 'SELECT * FROM "t" WHERE "amount" >= 3 ORDER BY "amount" DESC NULLS LAST LIMIT 500 OFFSET 20',
      });
    });

    it('groups and aggregates, counting groups for the total', () => {
      expect(
        buildDatasetSql('t', columns, {
          groupBy: 'region',
          aggregate: { column: 'amount', fn: 'sum' },
          sort: { column: 'value', direction: 'asc' },
        }),
      ).toEqual({
        total:
          'SELECT count(*) AS count FROM (SELECT "region" FROM "t" GROUP BY "region") grouped',
        rows: 'SELECT "region", SUM("amount") AS value FROM "t" GROUP BY "region" ORDER BY "value" ASC NULLS LAST LIMIT 100 OFFSET 0',
      });
      expect(
        buildDatasetSql('t', columns, {
          groupBy: 'region',
          aggregate: { fn: 'count' },
        }).rows,
      ).toContain('COUNT(*) AS value');
    });

    it.each([
      [{ groupBy: 'secret', aggregate: { fn: 'count' } }, 'grouping column'],
      [{ groupBy: 'region' }, 'aggregate operation'],
      [
        { groupBy: 'region', aggregate: { column: 'secret', fn: 'sum' } },
        'aggregate column',
      ],
      [
        { groupBy: 'region', aggregate: { column: 'amount', fn: 'drop' } },
        'Unsupported aggregate',
      ],
      [{ sort: { column: 'secret', direction: 'asc' } }, 'unknown column'],
      [
        {
          groupBy: 'region',
          aggregate: { fn: 'count' },
          sort: { column: 'amount', direction: 'asc' },
        },
        'unknown column',
      ],
    ])('rejects %j', (query, message) => {
      expect(() =>
        buildDatasetSql('t', columns, query as DatasetQuery),
      ).toThrow(message);
    });
  });
});
