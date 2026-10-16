import { currency, currencyExponent, type CurrencyCode } from './currencies.js';
import {
  divideRounded,
  formatDecimal,
  pow10,
  rescale,
  toDecimal,
  type RoundingMode,
} from './decimal.js';

/** Two amounts in different currencies met in one operation: convert one first. */
export class CurrencyMismatchError extends Error {
  readonly code = 'currency_mismatch';
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Currency mismatch: ${left} and ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

/** An amount with more decimals than its currency's minor unit (`12.345 EUR`). */
export class AmountPrecisionError extends Error {
  readonly code = 'amount_precision';
  constructor(
    readonly amount: string,
    readonly currency: string,
    readonly exponent: number,
  ) {
    super(
      `${amount} has more than ${exponent} decimal places, the minor unit of ${currency}`,
    );
    this.name = 'AmountPrecisionError';
  }
}

/** What `Money.toJSON()` gives, and the API's money object: the amount as a decimal string. */
export interface MoneyJson {
  amount: string;
  currency: string;
}

/**
 * An amount of money: an integer of minor units (cents, fils, yen) and its
 * ISO 4217 currency. Immutable; every operation returns a new one.
 *
 * - Arithmetic is on bigint minor units, exact. Where a result falls between
 *   two minor units (a multiplication, a division, a conversion), it is
 *   rounded once, by the operation's `rounding` (default `half-up`).
 * - Two currencies never mix: `plus`, `minus`, comparisons throw a
 *   CurrencyMismatchError (convert first: ExchangeRatesService.convert()).
 * - It never takes a JS number with a fraction: amounts arrive as decimal
 *   strings or bigint minor units.
 *
 * A domain class, not a row with functions: money has invariants (the
 * currency, the minor unit) that every feature would otherwise re-check
 * (docs/architecture.md, "When to break from it").
 */
export class Money {
  private constructor(
    /** The amount in minor units: 1234n is 12.34 EUR, 1234 JPY, 1.234 KWD. */
    readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {}

  /** From minor units (a stored `bigint` column): `Money.ofMinor(1234n, 'EUR')` is 12.34 EUR. */
  static ofMinor(minor: bigint | string | number, code: string): Money {
    const value = toDecimal(minor);
    if (value.scale !== 0) {
      throw new RangeError(`Minor units are an integer: ${String(minor)}`);
    }
    return new Money(value.units, currency(code));
  }

  /**
   * From a decimal string in major units, exactly: `Money.of('12.34', 'EUR')`.
   * More decimals than the currency has is an AmountPrecisionError, never a
   * silent rounding (`fromDecimal()` rounds on purpose).
   */
  static of(amount: string | bigint | number, code: string): Money {
    const exponent = currencyExponent(code);
    const value = toDecimal(amount);
    if (value.scale > exponent) {
      const scaled = rescale(value, exponent, 'down');
      // Trailing zeros are exact: 12.340 EUR is 12.34 EUR.
      if (scaled * pow10(value.scale - exponent) !== value.units) {
        throw new AmountPrecisionError(String(amount), code, exponent);
      }
      return new Money(scaled, currency(code));
    }
    return new Money(rescale(value, exponent), currency(code));
  }

  /**
   * From a decimal of any precision (a unit price times a quantity, a
   * numeric column), rounded to the minor unit by `rounding`.
   */
  static fromDecimal(
    amount: string | bigint | number,
    code: string,
    rounding: RoundingMode = 'half-up',
  ): Money {
    return new Money(
      rescale(toDecimal(amount), currencyExponent(code), rounding),
      currency(code),
    );
  }

  static zero(code: string): Money {
    return new Money(0n, currency(code));
  }

  /** The sum of `amounts`, all in one currency; `zero(code)` when empty. */
  static sum(amounts: readonly Money[], code?: string): Money {
    const of = code ?? amounts[0]?.currency;
    if (!of) {
      throw new RangeError('Money.sum() of nothing needs a currency');
    }
    let total = Money.zero(of);
    for (const amount of amounts) {
      total = total.plus(amount);
    }
    return total;
  }

  /** The decimal places of the currency's minor unit. */
  get exponent(): number {
    return currencyExponent(this.currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negated(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return this.minor < 0n ? this.negated() : this;
  }

  /**
   * Times a decimal factor (a quantity, a tax rate `"0.19"`, a discount),
   * rounded once to the minor unit.
   */
  times(
    factor: string | bigint | number,
    rounding: RoundingMode = 'half-up',
  ): Money {
    const f = toDecimal(factor);
    return new Money(
      divideRounded(this.minor * f.units, pow10(f.scale), rounding),
      this.currency,
    );
  }

  /** Divided by a decimal divisor (the net of a gross: `dividedBy("1.19")`), rounded once. */
  dividedBy(
    divisor: string | bigint | number,
    rounding: RoundingMode = 'half-up',
  ): Money {
    const d = toDecimal(divisor);
    return new Money(
      divideRounded(this.minor * pow10(d.scale), d.units, rounding),
      this.currency,
    );
  }

  /**
   * Splits the amount by `ratios` without losing or making a minor unit:
   * the parts always add up to the amount (largest remainder method). Each
   * part gets the floor of its exact share; the minor units left over go one
   * each to the parts with the largest remainders, ties to the earlier part,
   * so the result is deterministic. A zero ratio gets zero. A negative
   * amount is split as its absolute value, then negated, so `-x` splits as
   * the mirror of `x`.
   *
   * `allocate([1, 1, 1])` of 100.00 EUR: 33.34, 33.33, 33.33.
   */
  allocate(ratios: readonly (string | bigint | number)[]): Money[] {
    if (ratios.length === 0) {
      throw new RangeError('allocate() needs at least one ratio');
    }
    const decimals = ratios.map((ratio) => toDecimal(ratio));
    const scale = Math.max(...decimals.map((d) => d.scale));
    const weights = decimals.map((d) => d.units * pow10(scale - d.scale));
    if (weights.some((weight) => weight < 0n)) {
      throw new RangeError('allocate() ratios must not be negative');
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0n);
    if (total === 0n) {
      throw new RangeError('allocate() needs a ratio above zero');
    }
    const negative = this.minor < 0n;
    const amount = negative ? -this.minor : this.minor;
    const shares = weights.map((weight) => (amount * weight) / total);
    const remainders = weights.map((weight) => (amount * weight) % total);
    let left = amount - shares.reduce((sum, share) => sum + share, 0n);
    const order = remainders
      .map((remainder, index) => ({ remainder, index }))
      .filter(({ remainder }) => remainder > 0n)
      .sort((a, b) =>
        a.remainder === b.remainder
          ? a.index - b.index
          : a.remainder > b.remainder
            ? -1
            : 1,
      );
    for (const { index } of order) {
      if (left === 0n) {
        break;
      }
      shares[index] += 1n;
      left -= 1n;
    }
    return shares.map(
      (share) => new Money(negative ? -share : share, this.currency),
    );
  }

  /** `parts` equal parts (as equal as minor units allow: the first ones get the extra unit). */
  split(parts: number): Money[] {
    if (!Number.isSafeInteger(parts) || parts < 1) {
      throw new RangeError('split() needs a whole number of parts, 1 or more');
    }
    return this.allocate(Array.from({ length: parts }, () => 1));
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  /** -1, 0 or 1; another currency is a CurrencyMismatchError. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.minor === other.minor ? 0 : this.minor < other.minor ? -1 : 1;
  }

  /** Same currency and amount (another currency is simply not equal). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** The amount in major units, with exactly the currency's decimals: `"12.30"`, `"-0.05"`, `"1200"` (JPY). */
  toDecimal(): string {
    return formatDecimal(this.minor, this.exponent);
  }

  /** `{ amount: "12.30", currency: "EUR" }`: what the API sends. */
  toJSON(): MoneyJson {
    return { amount: this.toDecimal(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money) {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
