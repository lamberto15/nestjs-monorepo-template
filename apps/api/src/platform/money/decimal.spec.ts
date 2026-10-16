import {
  divideRounded,
  formatDecimal,
  InvalidDecimalError,
  multiplyDecimals,
  normalizeDecimal,
  ROUNDING_MODES,
  toDecimal,
  type RoundingMode,
} from './decimal.js';
import { random } from './random.testing.js';

describe('toDecimal', () => {
  it('reads decimal strings, bigints and safe integers exactly', () => {
    expect(toDecimal('12.340')).toEqual({ units: 12340n, scale: 3 });
    expect(toDecimal('-0.05')).toEqual({ units: -5n, scale: 2 });
    expect(toDecimal('7')).toEqual({ units: 7n, scale: 0 });
    expect(toDecimal(123n)).toEqual({ units: 123n, scale: 0 });
    expect(toDecimal(-42)).toEqual({ units: -42n, scale: 0 });
    expect(toDecimal('123456789012345678901234567890.123456789')).toEqual({
      units: 123456789012345678901234567890123456789n,
      scale: 9,
    });
  });

  it('refuses floats, exponents, grouping and half-written numbers', () => {
    for (const bad of [
      0.1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      '1e3',
      '1,5',
      '.5',
      '5.',
      '+5',
      ' 5',
      '',
      '--1',
      '0x10',
    ]) {
      expect(() => toDecimal(bad as string), String(bad)).toThrow(
        InvalidDecimalError,
      );
    }
  });
});

describe('formatDecimal and normalizeDecimal', () => {
  it('writes units at a scale, with every decimal', () => {
    expect(formatDecimal(1234n, 2)).toBe('12.34');
    expect(formatDecimal(-5n, 2)).toBe('-0.05');
    expect(formatDecimal(5n, 3)).toBe('0.005');
    expect(formatDecimal(1200n, 0)).toBe('1200');
    expect(formatDecimal(0n, 2)).toBe('0.00');
    expect(formatDecimal(-1000n, 3)).toBe('-1.000');
  });

  it('drops trailing zeros when normalizing', () => {
    expect(normalizeDecimal('1.50')).toBe('1.5');
    expect(normalizeDecimal('2.000')).toBe('2');
    expect(normalizeDecimal('-0.0100')).toBe('-0.01');
    expect(normalizeDecimal('0.0')).toBe('0');
  });

  it('round-trips random values', () => {
    const next = random(1);
    for (let i = 0; i < 2000; i++) {
      const units = next.bigint(10n ** 20n) * (next.int(2) ? -1n : 1n);
      const scale = next.int(8);
      const written = formatDecimal(units, scale);
      expect(toDecimal(written)).toEqual({ units, scale });
    }
  });
});

describe('divideRounded', () => {
  // Java's RoundingMode table: the value, then up, down, ceiling, floor, half-up, half-down, half-even.
  const TABLE: [
    string,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ][] = [
    ['5.5', 6, 5, 6, 5, 6, 5, 6],
    ['2.5', 3, 2, 3, 2, 3, 2, 2],
    ['1.6', 2, 1, 2, 1, 2, 2, 2],
    ['1.1', 2, 1, 2, 1, 1, 1, 1],
    ['1.0', 1, 1, 1, 1, 1, 1, 1],
    ['-1.0', -1, -1, -1, -1, -1, -1, -1],
    ['-1.1', -2, -1, -1, -2, -1, -1, -1],
    ['-1.6', -2, -1, -1, -2, -2, -2, -2],
    ['-2.5', -3, -2, -2, -3, -3, -2, -2],
    ['-5.5', -6, -5, -5, -6, -6, -5, -6],
    ['0.5', 1, 0, 1, 0, 1, 0, 0],
    ['-0.5', -1, 0, 0, -1, -1, 0, 0],
    ['3.5', 4, 3, 4, 3, 4, 3, 4],
  ];
  const MODES: RoundingMode[] = [
    'up',
    'down',
    'ceiling',
    'floor',
    'half-up',
    'half-down',
    'half-even',
  ];

  it.each(TABLE)(
    'rounds %s as Java’s RoundingMode does',
    (value, ...expected) => {
      const { units, scale } = toDecimal(value);
      MODES.forEach((mode, index) => {
        expect(
          Number(divideRounded(units, 10n ** BigInt(scale), mode)),
          `${value} ${mode}`,
        ).toBe(expected[index]);
      });
    },
  );

  it('defaults to half-up and handles negative denominators', () => {
    expect(divideRounded(5n, 2n)).toBe(3n);
    expect(divideRounded(5n, -2n)).toBe(-3n);
    expect(divideRounded(-5n, -2n)).toBe(3n);
    expect(divideRounded(5n, -2n, 'half-even')).toBe(-2n);
    expect(() => divideRounded(1n, 0n)).toThrow(RangeError);
  });

  it('keeps every mode within one unit of the exact quotient, on the side it promises (random)', () => {
    const next = random(2);
    for (let i = 0; i < 5000; i++) {
      const n = next.bigint(10n ** 24n) * (next.int(2) ? -1n : 1n);
      const d = (next.bigint(10n ** 12n) + 1n) * (next.int(2) ? -1n : 1n);
      // The exact quotient, compared without division: r is right when n/d - r is in the mode's range.
      const sign = d < 0n ? -1n : 1n;
      const num = n * sign; // n/d = num/den with den > 0
      const den = d * sign;
      const results = Object.fromEntries(
        ROUNDING_MODES.map((mode) => [mode, divideRounded(n, d, mode)]),
      ) as Record<RoundingMode, bigint>;
      for (const mode of ROUNDING_MODES) {
        const r = results[mode];
        const diff = num - r * den; // (exact - r) × den
        expect(diff < den && diff > -den, mode).toBe(true);
        if (mode.startsWith('half')) {
          expect(2n * (diff < 0n ? -diff : diff) <= den, mode).toBe(true);
        }
      }
      expect(num - results.floor * den >= 0n).toBe(true);
      expect(num - results.ceiling * den <= 0n).toBe(true);
      const abs = (x: bigint) => (x < 0n ? -x : x);
      expect(abs(results.down) * den <= abs(num)).toBe(true);
      expect(abs(results.up) * den >= abs(num)).toBe(true);
      // Symmetric modes mirror around zero; floor mirrors ceiling.
      for (const mode of [
        'half-up',
        'half-even',
        'half-down',
        'up',
        'down',
      ] as const) {
        expect(divideRounded(-n, d, mode)).toBe(-results[mode]);
      }
      expect(divideRounded(-n, d, 'floor')).toBe(-results.ceiling);
    }
  });

  it('breaks exact ties to the even neighbour with half-even (random)', () => {
    const next = random(3);
    for (let i = 0; i < 1000; i++) {
      const q = next.bigint(10n ** 15n) * (next.int(2) ? -1n : 1n);
      // q + 0.5 exactly, as (2q + 1) / 2.
      const n = 2n * q + (q < 0n ? -1n : 1n);
      const r = divideRounded(n, 2n, 'half-even');
      expect(r % 2n).toBe(0n);
      const away = divideRounded(n, 2n, 'half-up');
      expect(away < 0n ? -away : away).toBe((q < 0n ? -q : q) + 1n);
    }
  });
});

describe('multiplyDecimals', () => {
  it('multiplies exactly', () => {
    expect(multiplyDecimals('2.5', '0.19')).toBe('0.475');
    expect(multiplyDecimals('0.1', '0.2')).toBe('0.02');
    expect(multiplyDecimals('-3', '1.25')).toBe('-3.75');
    expect(multiplyDecimals('19.99', 3)).toBe('59.97');
  });
});
