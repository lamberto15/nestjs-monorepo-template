import { describe, expect, it } from 'vitest';
import { jsonRowsToArrow } from './json-table';

describe('JSON-to-Arrow table conversion', () => {
  it('preserves all-null columns and string values such as leading zeroes and empty text', () => {
    const table = jsonRowsToArrow([
      { code: '001', label: '', missing: null },
      { code: '002', label: 'value', missing: null },
    ]);
    expect(
      table.toArray().map((row) => Object.fromEntries(Object.entries(row))),
    ).toEqual([
      { code: '001', label: '', missing: null },
      { code: '002', label: 'value', missing: null },
    ]);
  });

  it('keeps mixed primitive values and differing nested object keys as JSON text', () => {
    const table = jsonRowsToArrow([
      { mixed: 1, nested: { x: 1 } },
      { mixed: 'word', nested: { y: 2 } },
    ]);
    expect(
      table.toArray().map((row) => Object.fromEntries(Object.entries(row))),
    ).toEqual([
      { mixed: '1', nested: '{"x":1}' },
      { mixed: '"word"', nested: '{"y":2}' },
    ]);
  });
});
