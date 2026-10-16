import {
  char,
  date,
  numeric,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';

/**
 * Exchange rates by day and source: `rate` units of `currency` buy one unit
 * of `base` on `day` (the ECB's: EUR base, its reference rates of that
 * working day). Written by ExchangeRatesJob (an ECB correction updates the
 * row), read by ExchangeRatesService, which converts through the base. Rates
 * are `numeric`, read as decimal strings: never floats.
 */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuidPk(),
    /** Who published the rate: `ecb`. */
    source: text('source').notNull(),
    /** The day the rate is the reference of (the publisher's date, yyyy-mm-dd). */
    day: date('day').notNull(),
    /** The currency the rate is quoted against: `EUR` for the ECB. */
    base: char('base', { length: 3 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Units of `currency` per one `base`: `1.1652` USD per EUR. */
    rate: numeric('rate').notNull(),
    ...timestamps(),
  },
  (table) => [
    // A day's rates, and the newest day on or before a date, per source.
    uniqueIndex('exchange_rates_source_day_currency_idx').on(
      table.source,
      table.day,
      table.currency,
    ),
  ],
);

export type ExchangeRate = typeof exchangeRates.$inferSelect;
