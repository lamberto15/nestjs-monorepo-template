import {
  CURRENCY_CODES,
  currencyExponent,
  isCurrency,
  UnknownCurrencyError,
} from './currencies.js';
import { InvalidDecimalError, ROUNDING_MODES } from './decimal.js';
import { AmountPrecisionError, CurrencyMismatchError, Money } from './money.js';
import { random } from './random.testing.js';

const amounts = (parts: Money[]) => parts.map((part) => part.toDecimal());

describe('currencies', () => {
  it('knows ISO 4217 exponents: 0, 2, 3 and 4 decimals', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('AED')).toBe(2);
    expect(currencyExponent('MYR')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
    expect(currencyExponent('CLF')).toBe(4);
    // ISO 4217, not CLDR's display digits (CLDR writes these with none).
    expect(currencyExponent('IRR')).toBe(2);
    expect(currencyExponent('RSD')).toBe(2);
  });

  it('refuses unknown, lower-case and unit-less codes', () => {
    for (const code of ['eur', 'EURO', 'XAU', 'XXX', 'ABC', '']) {
      expect(isCurrency(code)).toBe(false);
      expect(() => currencyExponent(code)).toThrow(UnknownCurrencyError);
    }
    expect(CURRENCY_CODES.length).toBeGreaterThan(150);
    expect(CURRENCY_CODES).toContain('EUR');
  });
});

describe('Money', () => {
  it('reads decimal strings exactly in each exponent', () => {
    expect(Money.of('12.34', 'EUR').minor).toBe(1234n);
    expect(Money.of('12.3', 'EUR').toDecimal()).toBe('12.30');
    expect(Money.of('12.340', 'EUR').toDecimal()).toBe('12.34');
    expect(Money.of('1200', 'JPY').minor).toBe(1200n);
    expect(Money.of('1.5', 'KWD').toDecimal()).toBe('1.500');
    expect(Money.of('-0.05', 'EUR').toDecimal()).toBe('-0.05');
    expect(Money.of(7, 'EUR').toDecimal()).toBe('7.00');
    expect(Money.ofMinor(1234n, 'KWD').toDecimal()).toBe('1.234');
    expect(Money.ofMinor('-1', 'EUR').toDecimal()).toBe('-0.01');
    expect(Money.ofMinor(5, 'JPY').toDecimal()).toBe('5');
    // Far past a double's 2^53.
    expect(Money.of('92233720368547758.07', 'EUR').minor).toBe(
      9223372036854775807n,
    );
  });

  it('never rounds input silently, and never takes a float', () => {
    expect(() => Money.of('12.345', 'EUR')).toThrow(AmountPrecisionError);
    expect(() => Money.of('1.5', 'JPY')).toThrow(AmountPrecisionError);
    expect(() => Money.of('0.0001', 'KWD')).toThrow(AmountPrecisionError);
    expect(() => Money.of(0.1, 'EUR')).toThrow(InvalidDecimalError);
    expect(() => Money.ofMinor('1.5', 'EUR')).toThrow(RangeError);
    expect(() => Money.of('1', 'eur')).toThrow(UnknownCurrencyError);
  });

  it('rounds on purpose with fromDecimal (a unit price times a quantity)', () => {
    expect(Money.fromDecimal('12.345', 'EUR').toDecimal()).toBe('12.35');
    expect(Money.fromDecimal('12.345', 'EUR', 'half-even').toDecimal()).toBe(
      '12.34',
    );
    expect(Money.fromDecimal('-12.345', 'EUR').toDecimal()).toBe('-12.35');
    expect(Money.fromDecimal('0.0125', 'KWD').toDecimal()).toBe('0.013');
    expect(Money.fromDecimal('99.5', 'JPY').toDecimal()).toBe('100');
    expect(Money.fromDecimal('99.5', 'JPY', 'down').toDecimal()).toBe('99');
  });

  it('adds and subtracts in one currency, and refuses two', () => {
    const a = Money.of('10.10', 'EUR');
    const b = Money.of('0.95', 'EUR');
    expect(a.plus(b).toDecimal()).toBe('11.05');
    expect(b.minus(a).toDecimal()).toBe('-9.15');
    expect(a.negated().abs().equals(a)).toBe(true);
    expect(Money.sum([a, b, b]).toDecimal()).toBe('12.00');
    expect(Money.sum([], 'JPY').toDecimal()).toBe('0');
    expect(() => Money.sum([])).toThrow(RangeError);
    expect(a.compare(b)).toBe(1);
    expect(b.compare(a)).toBe(-1);
    expect(a.compare(Money.of('10.1', 'EUR'))).toBe(0);

    const usd = Money.of('10.10', 'USD');
    expect(() => a.plus(usd)).toThrow(CurrencyMismatchError);
    expect(() => a.minus(usd)).toThrow(CurrencyMismatchError);
    expect(() => a.compare(usd)).toThrow(CurrencyMismatchError);
    expect(() => Money.sum([a, usd])).toThrow(CurrencyMismatchError);
    expect(a.equals(usd)).toBe(false);
    try {
      a.plus(usd);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'currency_mismatch',
        left: 'EUR',
        right: 'USD',
      });
    }
  });

  it('multiplies and divides with one rounding, half-up by default', () => {
    const price = Money.of('19.99', 'EUR');
    expect(price.times(3).toDecimal()).toBe('59.97');
    // VAT: 19.99 × 0.19 = 3.7981
    expect(price.times('0.19').toDecimal()).toBe('3.80');
    // 0.05 × 0.5 = 0.025: a tie.
    const nickel = Money.of('0.05', 'EUR');
    expect(nickel.times('0.5').toDecimal()).toBe('0.03');
    expect(nickel.times('0.5', 'half-even').toDecimal()).toBe('0.02');
    expect(nickel.times('0.5', 'half-down').toDecimal()).toBe('0.02');
    expect(nickel.negated().times('0.5').toDecimal()).toBe('-0.03');
    expect(nickel.negated().times('0.5', 'floor').toDecimal()).toBe('-0.03');
    expect(nickel.negated().times('0.5', 'ceiling').toDecimal()).toBe('-0.02');
    // The net of a gross: 119.00 / 1.19.
    expect(Money.of('119', 'EUR').dividedBy('1.19').toDecimal()).toBe('100.00');
    expect(Money.of('100', 'EUR').dividedBy(3).toDecimal()).toBe('33.33');
    expect(Money.of('1', 'KWD').dividedBy(3, 'up').toDecimal()).toBe('0.334');
    expect(() => price.times(0.19)).toThrow(InvalidDecimalError);
    expect(() => price.dividedBy('0')).toThrow(RangeError);
  });

  it('allocates without losing a minor unit, the extra ones to the largest remainders', () => {
    expect(amounts(Money.of('100', 'EUR').allocate([1, 1, 1]))).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ]);
    expect(amounts(Money.of('-100', 'EUR').allocate([1, 1, 1]))).toEqual([
      '-33.34',
      '-33.33',
      '-33.33',
    ]);
    expect(amounts(Money.of('100', 'JPY').allocate([1, 1, 1]))).toEqual([
      '34',
      '33',
      '33',
    ]);
    expect(amounts(Money.of('1', 'KWD').allocate([1, 1, 1]))).toEqual([
      '0.334',
      '0.333',
      '0.333',
    ]);
    // 0.05 by 70/20/10: exact shares 0.035, 0.010, 0.005; remainders .5, 0, .5 → the first.
    expect(
      amounts(Money.of('0.05', 'EUR').allocate(['0.7', '0.2', '0.1'])),
    ).toEqual(['0.04', '0.01', '0.00']);
    // The largest remainder wins over the order: 10 cents by 1:2 are 3.33 and 6.67 cents.
    expect(amounts(Money.of('0.10', 'EUR').allocate([1, 2]))).toEqual([
      '0.03',
      '0.07',
    ]);
    expect(amounts(Money.of('0.07', 'EUR').allocate([1, 0, 1]))).toEqual([
      '0.04',
      '0.00',
      '0.03',
    ]);
    expect(amounts(Money.of('5', 'EUR').split(2))).toEqual(['2.50', '2.50']);
    expect(amounts(Money.of('0.01', 'EUR').split(3))).toEqual([
      '0.01',
      '0.00',
      '0.00',
    ]);
  });

  it('refuses allocations that mean nothing', () => {
    const amount = Money.of('1', 'EUR');
    expect(() => amount.allocate([])).toThrow(RangeError);
    expect(() => amount.allocate([0, 0])).toThrow(RangeError);
    expect(() => amount.allocate([1, -1, 2])).toThrow(RangeError);
    expect(() => amount.allocate([0.5, 0.5])).toThrow(InvalidDecimalError);
    expect(() => amount.split(0)).toThrow(RangeError);
    expect(() => amount.split(1.5)).toThrow(RangeError);
  });

  it('allocates any amount by any ratios exactly, fairly and deterministically (random)', () => {
    const next = random(42);
    const codes = ['JPY', 'EUR', 'KWD', 'CLF'];
    for (let i = 0; i < 3000; i++) {
      const code = next.pick(codes);
      const minor = next.bigint(10n ** 18n) * (next.int(2) ? -1n : 1n);
      const amount = Money.ofMinor(minor, code);
      const count = 1 + next.int(8);
      let ratios = Array.from({ length: count }, () =>
        next.int(4) === 0
          ? '0'
          : `${next.int(1000)}.${String(next.int(100)).padStart(2, '0')}`,
      );
      if (ratios.every((ratio) => Number(ratio) === 0)) {
        ratios = [...ratios.slice(1), '1'];
      }
      const parts = amount.allocate(ratios);

      expect(parts).toHaveLength(count);
      // Nothing lost or made.
      expect(parts.reduce((sum, part) => sum + part.minor, 0n)).toBe(minor);
      // Each part within one minor unit of its exact share, on the amount's side.
      const weights = ratios.map((ratio) => BigInt(ratio.replace('.', '')));
      const total = weights.reduce((sum, weight) => sum + weight, 0n);
      parts.forEach((part, index) => {
        expect(part.currency).toBe(code);
        const exact = minor * weights[index]; // share × total
        const diff = part.minor * total - exact;
        expect(diff < total && diff > -total).toBe(true);
        if (weights[index] === 0n) {
          expect(part.minor).toBe(0n);
        }
        expect(part.minor === 0n || part.minor < 0n === minor < 0n).toBe(true);
      });
      // The same call, the same parts; the opposite amount, the mirror.
      expect(amounts(amount.allocate(ratios))).toEqual(amounts(parts));
      expect(
        amount
          .negated()
          .allocate(ratios)
          .map((part) => part.minor),
      ).toEqual(parts.map((part) => -part.minor));
    }
  });

  it('rounds products to within half a minor unit in every half mode (random)', () => {
    const next = random(7);
    for (let i = 0; i < 2000; i++) {
      const code = next.pick(['JPY', 'EUR', 'KWD']);
      const amount = Money.ofMinor(
        next.bigint(10n ** 15n) * (next.int(2) ? -1n : 1n),
        code,
      );
      const factor = `${next.int(100)}.${String(next.int(10000)).padStart(4, '0')}`;
      const exact = amount.minor * BigInt(factor.replace('.', '')); // × 10^4
      for (const mode of ROUNDING_MODES) {
        const diff = amount.times(factor, mode).minor * 10_000n - exact;
        const abs = diff < 0n ? -diff : diff;
        expect(abs < 10_000n, mode).toBe(true);
        if (mode.startsWith('half')) {
          expect(abs <= 5_000n, mode).toBe(true);
        }
      }
    }
  });

  it('serializes as decimal strings, never numbers', () => {
    expect(JSON.parse(JSON.stringify(Money.of('1234.5', 'EUR')))).toEqual({
      amount: '1234.50',
      currency: 'EUR',
    });
    expect(Money.of('3', 'KWD').toString()).toBe('3.000 KWD');
  });
});
