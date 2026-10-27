import { describe, expect, it } from 'vitest';
import { isNumericColumn, isTemporalColumn } from './column-types';

describe('column types', () => {
  it.each([
    'INTEGER',
    'BIGINT',
    'DOUBLE',
    'DECIMAL(12,2)',
    'UTINYINT',
    'HUGEINT',
  ])('treats %s as numeric', (type) => {
    expect(isNumericColumn(type)).toBe(true);
    expect(isTemporalColumn(type)).toBe(false);
  });

  it.each([
    'DATE',
    'TIMESTAMP',
    'TIMESTAMP_S',
    'TIMESTAMP_MS',
    'TIMESTAMP WITH TIME ZONE',
  ])('treats %s as temporal', (type) => {
    expect(isTemporalColumn(type)).toBe(true);
    expect(isNumericColumn(type)).toBe(false);
  });

  it.each(['VARCHAR', 'BOOLEAN', 'STRUCT(a INTEGER)', 'INTEGER[]', 'TIME'])(
    'treats %s as neither',
    (type) => {
      expect(isNumericColumn(type)).toBe(false);
      expect(isTemporalColumn(type)).toBe(false);
    },
  );
});
