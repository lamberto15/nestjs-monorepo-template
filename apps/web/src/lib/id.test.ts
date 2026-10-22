import { describe, expect, it } from 'vitest';
import { generateId } from './id';

describe('generateId', () => {
  it('makes 12 letters and digits by default', () => {
    expect(generateId()).toMatch(/^[0-9A-Za-z]{12}$/);
  });

  it('takes a length and an alphabet, as options or after a prefix argument', () => {
    expect(generateId({ length: 8 })).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(generateId({ alphabet: 'ab', length: 40 })).toMatch(/^[ab]{40}$/);
    expect(generateId('filter', { alphabet: 'xyz', length: 5 })).toMatch(
      /^[xyz]{5}$/,
    );
    expect(generateId({ length: 0 })).toBe('');
  });

  it('uses the whole alphabet and does not repeat itself', () => {
    const seen = new Set(generateId({ alphabet: '01', length: 200 }));
    expect([...seen].sort()).toEqual(['0', '1']);
    expect(new Set(Array.from({ length: 50 }, () => generateId())).size).toBe(
      50,
    );
  });
});
