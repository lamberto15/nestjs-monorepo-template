/**
 * Exact decimal arithmetic on bigint, for money: a decimal is an integer
 * and a scale (`12.345` = 12345 at scale 3). Values travel as strings
 * (`"12.345"`), never as JS numbers, whose binary fractions can't hold 0.1.
 *
 * Custom code: neither Nest nor the installed packages do decimal
 * arithmetic, and what this needs (parse, multiply, divide with a rounding
 * mode) is a few bigint operations; a decimal library would add a
 * dependency and a second number type to every signature.
 */

/**
 * How a result between two integers is rounded:
 * - `half-up`: to the nearest, ties away from zero (2.5 → 3, -2.5 → -3).
 *   The default: invoices and VAT round this way.
 * - `half-even`: to the nearest, ties to the even neighbour (2.5 → 2,
 *   3.5 → 4): banker's rounding, no upward drift over many roundings.
 * - `half-down`: to the nearest, ties toward zero (2.5 → 2, -2.5 → -2).
 * - `up`: away from zero; `down`: toward zero (truncate).
 * - `ceiling`: toward +∞; `floor`: toward −∞.
 */
export type RoundingMode =
  'half-up' | 'half-even' | 'half-down' | 'up' | 'down' | 'ceiling' | 'floor';

export const ROUNDING_MODES: readonly RoundingMode[] = [
  'half-up',
  'half-even',
  'half-down',
  'up',
  'down',
  'ceiling',
  'floor',
];

/** A decimal: `units / 10^scale`. */
export interface Decimal {
  units: bigint;
  scale: number;
}

/** A decimal string: digits, an optional fraction, an optional minus. No exponent, no grouping. */
export const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** Not a decimal string (`1e3`, `1,5`, `.5`, a float). */
export class InvalidDecimalError extends Error {
  readonly code = 'invalid_decimal';
  constructor(readonly value: unknown) {
    super(`Not a decimal: ${String(value)}`);
    this.name = 'InvalidDecimalError';
  }
}

/**
 * `value` as a decimal: a decimal string, a bigint, or a safe integer.
 * A number with a fraction is refused: it is already inexact.
 */
export function toDecimal(value: string | bigint | number): Decimal {
  if (typeof value === 'bigint') {
    return { units: value, scale: 0 };
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidDecimalError(value);
    }
    return { units: BigInt(value), scale: 0 };
  }
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new InvalidDecimalError(value);
  }
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

/** 10^n as a bigint. */
export function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** `units / 10^scale` written out: `-0.05`, `1200` (scale 0), always `scale` decimals. */
export function formatDecimal(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return (negative ? '-' : '') + whole + (scale > 0 ? `.${fraction}` : '');
}

/** The decimal string of `value` without trailing zeros (`1.50` → `1.5`, `2.000` → `2`). */
export function normalizeDecimal(value: string): string {
  const { units, scale } = toDecimal(value);
  let u = units;
  let s = scale;
  while (s > 0 && u % 10n === 0n) {
    u /= 10n;
    s -= 1;
  }
  return formatDecimal(u, s);
}

/**
 * `numerator / denominator` rounded to an integer by `mode`. The one place
 * money is rounded: every operation computes the exact ratio, then calls this
 * once.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator; // toward zero
  const remainder = numerator % denominator; // the numerator's sign
  if (remainder === 0n) {
    return quotient;
  }
  const away = numerator < 0n ? quotient - 1n : quotient + 1n;
  const twice = 2n * (remainder < 0n ? -remainder : remainder);
  switch (mode) {
    case 'down':
      return quotient;
    case 'up':
      return away;
    case 'floor':
      return numerator < 0n ? away : quotient;
    case 'ceiling':
      return numerator > 0n ? away : quotient;
    case 'half-up':
      return twice >= denominator ? away : quotient;
    case 'half-down':
      return twice > denominator ? away : quotient;
    case 'half-even':
      if (twice !== denominator) {
        return twice > denominator ? away : quotient;
      }
      return quotient % 2n === 0n ? quotient : away;
    default:
      throw new RangeError(`Unknown rounding mode: ${String(mode)}`);
  }
}

/** `value` rounded to `scale` decimals by `mode`, as units at that scale. */
export function rescale(
  value: Decimal,
  scale: number,
  mode: RoundingMode = 'half-up',
): bigint {
  return value.scale <= scale
    ? value.units * pow10(scale - value.scale)
    : divideRounded(value.units, pow10(value.scale - scale), mode);
}

/** The exact product of two decimal strings (`"2.5" × "0.19"` = `"0.475"`). */
export function multiplyDecimals(
  a: string | bigint | number,
  b: string | bigint | number,
): string {
  const x = toDecimal(a);
  const y = toDecimal(b);
  return formatDecimal(x.units * y.units, x.scale + y.scale);
}
