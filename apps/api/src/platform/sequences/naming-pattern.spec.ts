import {
  counterKey,
  dateValues,
  namesIn,
  parsePattern,
  PatternError,
  patternOf,
  printValue,
  renderPattern,
} from './naming-pattern.js';
import { formatNumber } from './sequences.service.js';

const october20 = {
  YYYY: '2026',
  YY: '26',
  MM: '10',
  DD: '20',
  JJJ: '293',
  WW: '43',
};
const at = { date: october20 };
const names = {
  fields: new Set(['customer', 'region']),
  variables: new Set(['FY', 'ABBR']),
};

describe('naming series patterns', () => {
  it('prints text, date parts and the padded counter', () => {
    const parts = parsePattern('INV-.YYYY.-.MM.-.#####');
    expect(renderPattern(parts, 42, at)).toBe('INV-2026-10-00042');
    expect(renderPattern(parsePattern('.YY.MM.DD.-.###'), 7, at)).toBe(
      '261020-007',
    );
    expect(renderPattern(parsePattern('INV/.YYYY./.###'), 7, at)).toBe(
      'INV/2026/007',
    );
    // A counter wider than its #s is printed whole.
    expect(renderPattern(parsePattern('T-.##'), 1234, at)).toBe(
      'T-1234',
    );
    // The counter may sit anywhere.
    expect(renderPattern(parsePattern('.####./.YYYY.'), 5, at)).toBe(
      '0005/2026',
    );
  });

  it('keys the counter by what prints around it', () => {
    const monthly = parsePattern('INV-.YYYY.-.MM.-.#####');
    expect(counterKey(monthly, at)).toBe('INV-2026-10-{#}');
    // Next month: another key, so the counter starts over.
    expect(counterKey(monthly, { date: { ...october20, MM: '11' } })).toBe(
      'INV-2026-11-{#}',
    );
    // A literal year and the date part share a counter, whatever the width.
    expect(counterKey(parsePattern('INV-2026-.####'), at)).toBe(
      counterKey(parsePattern('INV-.YYYY.-.#####'), at),
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
      expect(renderPattern(parts, 42, at)).toBe(
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
      JJJ: '365',
      WW: '53',
    });
    expect(dateValues(at, 'Asia/Kuala_Lumpur')).toEqual({
      YYYY: '2027',
      YY: '27',
      MM: '01',
      DD: '01',
      JJJ: '001',
      WW: '53',
    });
    // ISO weeks: 2026-01-01 is a Thursday, so week 1; 2027-01-04 a Monday, week 1.
    expect(dateValues(new Date('2026-01-01T12:00:00Z'), 'UTC').WW).toBe('01');
    expect(dateValues(new Date('2027-01-04T12:00:00Z'), 'UTC').WW).toBe('01');
    expect(dateValues(new Date('2026-10-20T12:00:00Z'), 'UTC')).toEqual(
      october20,
    );
  });

  it("prints the record's fields and variables, each value with its own counter", () => {
    const parts = parsePattern('INV-.ABBR.-.{customer}.-.FY.-.####', names);
    expect(namesIn(parts)).toEqual({
      fields: ['customer'],
      variables: ['ABBR', 'FY'],
    });
    const acme = {
      date: october20,
      fields: { customer: 'ACME' },
      variables: { ABBR: 'HQ', FY: '2026-2027' },
    };
    expect(renderPattern(parts, 7, acme)).toBe('INV-HQ-ACME-2026-2027-0007');
    expect(counterKey(parts, acme)).toBe('INV-HQ-ACME-2026-2027-{#}');
    expect(
      counterKey(parts, { ...acme, fields: { customer: 'GLOBEX' } }),
    ).not.toBe(counterKey(parts, acme));
    // Unknown values print as their names, for previews.
    expect(renderPattern(parts, 1, at)).toBe(
      'INV-{ABBR}-{customer}-{FY}-0001',
    );
    // Braced variables and date parts, as Frappe's format: rules write them.
    expect(
      renderPattern(parsePattern('{FY}.-.{YYYY}.-.###', names), 3, {
        date: october20,
        variables: { FY: '2026' },
      }),
    ).toBe('2026-2026-003');
  });

  it('refuses fields and variables the subject does not have, or touching the counter', () => {
    const refused = (pattern: string) => () => parsePattern(pattern, names);
    expect(refused('INV-.{price}.-.###')).toThrow(/neither a field/);
    expect(refused('INV-.{1x}.-.###')).toThrow(/is not a field/);
    expect(refused('INV-.{customer}.###')).toThrow(/separator/);
    expect(refused('INV-.FY.###')).toThrow(/separator/);
    expect(refused('.###.{region}')).toThrow(/separator/);
    // Without names (the body's check), any braced name is a field and FY is text.
    expect(parsePattern('INV-.{anything}.-.###')[1]).toEqual({
      kind: 'field',
      name: 'anything',
    });
    expect(parsePattern('FY-.###')[0]).toEqual({ kind: 'text', text: 'FY-' });
  });

  it('prints a field value as one token', () => {
    expect(printValue('  Acme Corp. ')).toBe('Acme-Corp');
    expect(printValue('東京 支店')).toBe('東京-支店');
    expect(printValue(42)).toBe('42');
    expect(printValue('<b>x</b>')).toBe('bx/b');
    expect(printValue('x'.repeat(80))).toHaveLength(40);
    expect(printValue('...')).toBeUndefined();
    expect(printValue(null)).toBeUndefined();
    expect(printValue({ a: 1 })).toBeUndefined();
  });
});
