import { describe, expect, it } from 'vitest';
import type { DatasetFilter } from './engine';
import { boundedPage, buildWhereClause, quoteIdentifier } from './query';

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
});
