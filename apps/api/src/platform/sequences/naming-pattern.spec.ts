import {
  counterKey,
  dateValues,
  parsePattern,
  PatternError,
  patternOf,
  renderPattern,
} from './naming-pattern.js';
import { formatNumber } from './sequences.service.js';

const october20 = { YYYY: '2026', YY: '26', MM: '10', DD: '20' };

describe('naming series patterns', () => {
  it('prints text, date parts and the padded counter', () => {
    const parts = parsePattern('INV-.YYYY.-.MM.-.#####');
    expect(renderPattern(parts, 42, october20)).toBe('INV-2026-10-00042');
    expect(renderPattern(parsePattern('.YY.MM.DD.-.###'), 7, october20)).toBe(
      '261020-007',
    );
    expect(renderPattern(parsePattern('INV/.YYYY./.###'), 7, october20)).toBe(
      'INV/2026/007',
    );
    // A counter wider than its #s is printed whole.
    expect(renderPattern(parsePattern('T-.##'), 1234, october20)).toBe(
      'T-1234',
    );
    // The counter may sit anywhere.
    expect(renderPattern(parsePattern('.####./.YYYY.'), 5, october20)).toBe(
      '0005/2026',
    );
  });

  it('keys the counter by what prints around it', () => {
    const monthly = parsePattern('INV-.YYYY.-.MM.-.#####');
    expect(counterKey(monthly, october20)).toBe('INV-2026-10-{#}');
    // Next month: another key, so the counter starts over.
    expect(counterKey(monthly, { ...october20, MM: '11' })).toBe(
      'INV-2026-11-{#}',
    );
    // A literal year and the date part share a counter, whatever the width.
    expect(counterKey(parsePattern('INV-2026-.####'), october20)).toBe(
      counterKey(parsePattern('INV-.YYYY.-.#####'), october20),
    );
  });

  it('refuses what is not a pattern', () => {
    const refused = (pattern: string) => () => parsePattern(pattern);
    expect(refused('INV-.YYYY.')).toThrow(PatternError); // no counter
    expect(refused('.###.-.##')).toThrow(/exactly one counter/);
    expect(refused('INV#.###')).toThrow(/is not a date part/);
    expect(refused('INV<b>.###')).toThrow(PatternError);
    expect(refused('INV .###')).toThrow(PatternError);
    // Digits or a date part touching the counter would merge with it.
    expect(refused('NOTE-1.#')).toThrow(/separator/);
    expect(refused('X-.#.1')).toThrow(/separator/);
    expect(refused('.YYYY.###')).toThrow(/separator/);
    expect(refused('.###.MM')).toThrow(/separator/);
    expect(refused(`.${'#'.repeat(13)}`)).toThrow(/at most 12/);
    expect(refused(`${'A'.repeat(60)}.#`)).toThrow(/1 to 60/);
    expect(refused('')).toThrow(PatternError);
  });

  it('reads a declared format as the pattern that prints the same', () => {
    const declared = [
      { prefix: 'NOTE', perYear: true, width: 5 },
      { prefix: 'INV' },
      { width: 3, perYear: true },
      {},
      { prefix: 'T', width: 3, separator: '/' },
    ];
    for (const format of declared) {
      const parts = parsePattern(patternOf(format));
      expect(renderPattern(parts, 42, october20)).toBe(
        formatNumber(42, format, format.perYear ? '2026' : undefined),
      );
    }
    expect(patternOf({ prefix: 'NOTE', perYear: true, width: 5 })).toBe(
      'NOTE-.YYYY.-.#####',
    );
  });

  it("takes the date parts in the app's time zone", () => {
    // 23:30 UTC on New Year's Eve is already the new year in Kuala Lumpur.
    const at = new Date('2026-12-31T23:30:00Z');
    expect(dateValues(at, 'UTC')).toEqual({
      YYYY: '2026',
      YY: '26',
      MM: '12',
      DD: '31',
    });
    expect(dateValues(at, 'Asia/Kuala_Lumpur')).toEqual({
      YYYY: '2027',
      YY: '27',
      MM: '01',
      DD: '01',
    });
  });
});
