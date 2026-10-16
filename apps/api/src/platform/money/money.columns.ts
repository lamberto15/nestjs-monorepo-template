import { bigint, char, date, numeric, text } from 'drizzle-orm/pg-core';
import { Money } from './money.js';

/** `unitPrice` → `unit_price`: the column names of the helpers below. */
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const columns = (name: string) => ({
  minor: bigint(`${snake(name)}_minor`, { mode: 'bigint' }),
  currency: char(`${snake(name)}_currency`, { length: 3 }),
});
const required = (name: string) => ({
  minor: columns(name).minor.notNull(),
  currency: columns(name).currency.notNull(),
});

type Required = ReturnType<typeof required>;
type Optional = ReturnType<typeof columns>;
export type MoneyColumns<
  N extends string,
  C extends { minor: unknown; currency: unknown },
> = { [K in `${N}Minor`]: C['minor'] } & {
  [K in `${N}Currency`]: C['currency'];
};

/**
 * An amount's columns, spread into a table: `...moneyColumns('total')` adds
 * `total_minor` (bigint: minor units, read as a JS bigint) and
 * `total_currency` (char(3): the ISO 4217 code) as `totalMinor` and
 * `totalCurrency`. NOT NULL unless `{ nullable: true }` (then a row sets
 * both or neither). Unit prices and rates, which have more decimals than
 * the minor unit, are `numeric()` columns instead (read as strings).
 *
 * ```ts
 * export const invoices = pgTable('invoices', {
 *   id: uuidPk(),
 *   ...moneyColumns('total'),
 *   unitPrice: numeric('unit_price').notNull(),
 *   ...timestamps(),
 * });
 * // write: { ...moneyValues('total', total) }; read: moneyOf(row, 'total')
 * ```
 */
export function moneyColumns<N extends string>(
  name: N,
): MoneyColumns<N, Required>;
export function moneyColumns<N extends string>(
  name: N,
  options: { nullable: true },
): MoneyColumns<N, Optional>;
export function moneyColumns(name: string, options?: { nullable: true }) {
  const made = options?.nullable ? columns(name) : required(name);
  return { [`${name}Minor`]: made.minor, [`${name}Currency`]: made.currency };
}

/**
 * The rate an amount was converted at, spread next to its `moneyColumns()`:
 * `...conversionColumns('totalEur')` adds `total_eur_rate` (numeric),
 * `total_eur_rate_date` (date: the rates' day) and `total_eur_rate_source`
 * (text: `ecb`). A converted amount is stored with them, from
 * `ExchangeRatesService.convert()`'s result (`conversionValues()`).
 */
export function conversionColumns<N extends string>(name: N) {
  const base = snake(name);
  const made = {
    rate: numeric(`${base}_rate`),
    rateDate: date(`${base}_rate_date`),
    rateSource: text(`${base}_rate_source`),
  };
  return {
    [`${name}Rate`]: made.rate,
    [`${name}RateDate`]: made.rateDate,
    [`${name}RateSource`]: made.rateSource,
  } as { [K in `${N}Rate`]: typeof made.rate } & {
    [K in `${N}RateDate`]: typeof made.rateDate;
  } & { [K in `${N}RateSource`]: typeof made.rateSource };
}

/** The values of `moneyColumns(name)` for `amount`, for an insert or update. */
export function moneyValues<N extends string>(name: N, amount: Money) {
  return {
    [`${name}Minor`]: amount.minor,
    [`${name}Currency`]: amount.currency,
  } as { [K in `${N}Minor`]: bigint } & { [K in `${N}Currency`]: string };
}

/** The values of `conversionColumns(name)` for a conversion's rate. */
export function conversionValues<N extends string>(
  name: N,
  conversion: { rate: string; rateDate: string; source: string },
) {
  return {
    [`${name}Rate`]: conversion.rate,
    [`${name}RateDate`]: conversion.rateDate,
    [`${name}RateSource`]: conversion.source,
  } as { [K in `${N}Rate`]: string } & { [K in `${N}RateDate`]: string } & {
    [K in `${N}RateSource`]: string;
  };
}

/** The amount in `row`'s `moneyColumns(name)`, or null when the (nullable) columns are. */
export function moneyOf<N extends string>(
  row: { [K in `${N}Minor`]: bigint | null } & {
    [K in `${N}Currency`]: string | null;
  },
  name: N,
): Money | null {
  const minor = row[`${name}Minor` as `${N}Minor`] as bigint | null;
  const code = row[`${name}Currency` as `${N}Currency`] as string | null;
  return minor === null || code === null ? null : Money.ofMinor(minor, code);
}
