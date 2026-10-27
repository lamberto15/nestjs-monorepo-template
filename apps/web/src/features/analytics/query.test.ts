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
        rows: 'SELECT "region", CAST(SUM("amount") AS DOUBLE) AS value FROM "t" GROUP BY "region" ORDER BY 2 ASC NULLS LAST LIMIT 100 OFFSET 0',
      });
      expect(
        buildDatasetSql('t', columns, {
          groupBy: 'region',
          aggregate: { fn: 'count' },
        }).rows,
      ).toContain('COUNT(*) AS value');
    });

    it('casts every aggregate but COUNT to DOUBLE so integers and decimals stay chartable', () => {
      const sql = (fn: 'sum' | 'avg' | 'min' | 'max') =>
        buildDatasetSql('t', columns, {
          groupBy: 'amount',
          aggregate: { column: 'amount', fn },
        }).rows;
      expect(sql('sum')).toContain('CAST(SUM("amount") AS DOUBLE) AS value');
      expect(sql('avg')).toContain('CAST(AVG("amount") AS DOUBLE) AS value');
      expect(sql('min')).toContain('CAST(MIN("amount") AS DOUBLE) AS value');
      expect(sql('max')).toContain('CAST(MAX("amount") AS DOUBLE) AS value');
    });

    it.each(['count', 'sum', 'avg', 'min', 'max'] as const)(
      'builds a %s aggregate for a grouped column',
      (fn) => {
        const sql = buildDatasetSql('t', columns, {
          groupBy: 'region',
          aggregate: fn === 'count' ? { fn } : { column: 'amount', fn },
        }).rows;
        expect(sql).toContain(
          fn === 'count'
            ? 'COUNT(*) AS value'
            : `CAST(${fn.toUpperCase()}("amount") AS DOUBLE)`,
        );
      },
    );

    it('bins a numeric column into at most 100 equal-width bins, filtered and without nulls', () => {
      const sql = buildDatasetSql('t', columns, {
        histogram: { column: 'amount', bins: 5_000 },
        filters: [{ column: 'region', operator: 'eq', value: "O'Hare" }],
      });
      expect(sql.rows).toContain(
        `FROM "t" WHERE "region" = 'O''Hare' AND isfinite(CAST("amount" AS DOUBLE)))`,
      );
      expect(sql.rows).toContain('* 100) AS INTEGER)');
      expect(sql.rows).toContain('ORDER BY bucket LIMIT 100 OFFSET 0');
      expect(sql.total).toMatch(/^SELECT count\(\*\) AS count FROM \(WITH r/);
      expect(
        buildDatasetSql('t', columns, { histogram: { column: 'amount' } }).rows,
      ).toContain('* 20) AS INTEGER)');
      expect(
        buildDatasetSql('t', columns, {
          histogram: { column: 'amount', bins: Number.NaN },
        }).rows,
      ).toContain('* 20) AS INTEGER)');
      expect(
        buildDatasetSql('t', columns, {
          histogram: { column: 'amount', bins: 0 },
        }).rows,
      ).toContain('* 1) AS INTEGER)');
    });

    it('buckets a date column by day, week or month, with a count by default', () => {
      const sql = buildDatasetSql('t', new Set(['when', 'amount']), {
        timeSeries: { column: 'when', unit: 'week' },
        filters: [{ column: 'amount', operator: 'gt', value: 1 }],
        limit: 9_000,
      });
      expect(sql.rows).toBe(
        `SELECT CAST(CAST(date_trunc('week', CAST("when" AS TIMESTAMP)) AS DATE) AS VARCHAR) AS bucket, COUNT(*) AS value FROM "t" WHERE "amount" > 1 AND "when" IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 500 OFFSET 0`,
      );
      expect(sql.total).toContain('FROM (SELECT CAST(CAST(date_trunc');
      expect(
        buildDatasetSql('t', new Set(['when', 'amount']), {
          timeSeries: { column: 'when', unit: 'month' },
          aggregate: { column: 'amount', fn: 'sum' },
        }).rows,
      ).toContain(`date_trunc('month'`);
    });

    it('quotes the identifiers of a histogram and a time series', () => {
      const odd = new Set(['a"b']);
      expect(
        buildDatasetSql('t', odd, { histogram: { column: 'a"b' } }).rows,
      ).toContain('CAST("a""b" AS DOUBLE)');
      expect(
        buildDatasetSql('t', odd, {
          timeSeries: { column: 'a"b', unit: 'day' },
        }).rows,
      ).toContain('CAST("a""b" AS TIMESTAMP)');
    });

    it.each([
      [{ histogram: { column: 'secret' } }, 'histogram column'],
      [{ timeSeries: { column: 'secret', unit: 'day' } }, 'time series column'],
      [{ timeSeries: { column: 'region', unit: "day'); --" } }, 'time unit'],
      [
        {
          timeSeries: { column: 'region', unit: 'day' },
          aggregate: { column: 'secret', fn: 'sum' },
        },
        'aggregate column',
      ],
      [
        {
          histogram: { column: 'amount' },
          groupBy: 'region',
          aggregate: { fn: 'count' },
        },
        'one of grouping',
      ],
      [
        {
          histogram: { column: 'amount' },
          timeSeries: { column: 'region', unit: 'day' },
        },
        'one of grouping',
      ],
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
