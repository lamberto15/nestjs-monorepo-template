import { describe, expect, it } from 'vitest';
import { jsonRowsToArrow } from './json-table';

describe('JSON-to-Arrow table conversion', () => {
  it('rejects files without tabular fields', () => {
    expect(() => jsonRowsToArrow([])).toThrow('no tabular fields');
    expect(() => jsonRowsToArrow([{}])).toThrow('no tabular fields');
  });

  it('preserves nullable booleans and missing keys that share prototype names', () => {
    const first = JSON.parse('{"__proto__":"value","enabled":true}');
    const table = jsonRowsToArrow([
      first,
      { enabled: false },
      { enabled: null },
    ]);
    expect(Array.from(table.getChild('enabled')!)).toEqual([true, false, null]);
    expect(Array.from(table.getChild('__proto__')!)).toEqual([
      'value',
      null,
      null,
    ]);
  });
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
