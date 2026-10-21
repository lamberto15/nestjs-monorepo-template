import { z } from 'zod';
import { currencyExponent, isCurrency } from './currencies.js';
import { DECIMAL_PATTERN, ROUNDING_MODES } from './decimal.js';

/**
 * The Zod pieces of money in the API. Amounts, unit prices and rates are
 * decimal strings end to end (`"12.34"`), typed `string` in OpenAPI: a JSON
 * number would pass through a float in most clients.
 */

/** An ISO 4217 code in capitals (`EUR`). */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: 'must be three capital letters (EUR)' })
  .refine(isCurrency, { message: 'must be an ISO 4217 currency code (EUR)' })
  .meta({
    description: 'An ISO 4217 currency code, in capitals.',
    example: 'EUR',
  });

/**
 * A decimal string of any precision (a unit price, a quantity, a rate):
 * `"0.0125"`, `"-3"`. Stored in a `numeric` column.
 */
export const decimalSchema = z
  .string()
  .regex(DECIMAL_PATTERN, {
    message: 'must be a decimal string: digits, an optional fraction (12.5)',
  })
  .max(64)
  .meta({ example: '12.5' });

/** A rounding mode (docs/money.md, "Rounding"). */
export const roundingSchema = z
  .enum(ROUNDING_MODES as [string, ...string[]])
  .default('half-up')
  .describe(
    'How a result between two minor units is rounded: half-up (ties away from zero, the default), half-even (banker’s), half-down, up, down, ceiling, floor.',
  );

/**
 * An issue on `amount` when it has more decimals than its currency's minor
 * unit (trailing zeros don't count: 12.340 EUR is 12.34 EUR).
 */
function checkMinorUnit(
  value: { amount: string; currency: string },
  ctx: z.RefinementCtx,
) {
  if (!isCurrency(value.currency) || !DECIMAL_PATTERN.test(value.amount)) {
    return; // their own issues
  }
  const decimals = value.amount.split('.')[1]?.replace(/0+$/, '').length ?? 0;
  const exponent = currencyExponent(value.currency);
  if (decimals > exponent) {
    ctx.addIssue({
      code: 'custom',
      path: ['amount'],
      message: `has more decimals than ${value.currency} has (${exponent})`,
    });
  }
}

/**
 * A money object in a body: `{ "amount": "12.34", "currency": "EUR" }`.
 * The amount has at most the currency's decimals (12.345 EUR is a 400:
 * rounding is the server's to decide, never implied by the input).
 * `Money.of(body.amount, body.currency)` reads it.
 */
export const moneySchema = z
  .object({
    amount: decimalSchema.describe(
      'The amount in major units, as a decimal string: "12.34". At most the currency’s decimals (0 for JPY, 2 for EUR, 3 for KWD).',
    ),
    currency: currencyCodeSchema,
  })
  .superRefine(checkMinorUnit);
type MoneyInput = z.infer<typeof moneySchema>;

/** A money object in a response: the amount always with exactly the currency's decimals. */
export const moneyResponseSchema = z
  .object({
    amount: z
      .string()
      .describe(
        'The amount in major units, with exactly the currency’s decimals: "12.30", "1200" (JPY), "1.250" (KWD).',
      ),
    currency: z.string().describe('ISO 4217.'),
  })
  .meta({ id: 'Money' });

const day = z.iso
  .date()
  .optional()
  .describe(
    'A day (yyyy-mm-dd): the rates of the newest working day on or before it. Default: today (UTC).',
  );

export const ratesQuerySchema = z.object({ date: day });
export type RatesQuery = z.infer<typeof ratesQuerySchema>;

export const ratesResponseSchema = z.object({
  source: z.string().describe('Whose rates: `ecb`.'),
  base: z.string().describe('The currency the rates are quoted against: EUR.'),
  day: z.iso.date().describe('The day of these rates.'),
  rates: z
    .record(z.string(), z.string())
    .describe(
      'Units of each currency per one `base`, as decimal strings: { "USD": "1.1652" }.',
    ),
});

export const convertQuerySchema = z
  .object({
    amount: decimalSchema.describe(
      'The amount to convert, in major units: "12.34".',
    ),
    currency: currencyCodeSchema.describe('The amount’s currency.'),
    to: currencyCodeSchema.describe('The currency to convert to.'),
    date: day,
    rounding: roundingSchema,
  })
  .superRefine(checkMinorUnit);
export type ConvertQuery = z.infer<typeof convertQuerySchema>;

export const conversionResponseSchema = z.object({
  from: moneyResponseSchema.describe('The amount asked for.'),
  amount: moneyResponseSchema.describe(
    'The converted amount, rounded once to the target’s minor unit.',
  ),
  rate: z
    .string()
    .describe(
      'Target units per source unit, to 10 decimals (half-up), to show and store. The amount is computed from the exact legs, not from it.',
    ),
  rateDate: z.iso
    .date()
    .describe(
      'The day of the rates used: the newest with both currencies on or before `date`.',
    ),
  source: z
    .string()
    .describe('Whose rates: `ecb` (`identity` for the same currency).'),
  base: z.string().describe('The currency both legs are quoted against.'),
  legs: z
    .object({ from: z.string(), to: z.string() })
    .describe(
      'Units of the source and the target currency per one `base` (1 for the base).',
    ),
  rounding: z.string(),
});
