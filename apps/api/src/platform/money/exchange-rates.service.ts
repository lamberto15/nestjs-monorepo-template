import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, count, desc, eq, inArray, lte, max, sql } from 'drizzle-orm';
import {
  database,
  inTransaction,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { currency } from './currencies.js';
import {
  divideRounded,
  formatDecimal,
  normalizeDecimal,
  pow10,
  toDecimal,
  type RoundingMode,
} from './decimal.js';
import type { RatesOfDay } from './ecb-rates.js';
import { Money } from './money.js';
import { exchangeRates } from './money.tables.js';

/** The ECB's euro foreign exchange reference rates. */
export const ECB = { source: 'ecb', base: 'EUR' } as const;

/** Decimal places of a conversion's `rate` (the cross rate, informational). */
export const RATE_SCALE = 10;

/** No rate for these currencies on or before the day asked. */
export class RateUnavailableError extends Error {
  readonly code = 'rate_unavailable';
  constructor(
    readonly currencies: string[],
    readonly day: string,
    readonly source: string,
  ) {
    super(
      `No ${source} exchange rate for ${currencies.join(', ')} on or before ${day}`,
    );
    this.name = 'RateUnavailableError';
  }
}

/** A converted amount, with what it was converted at. */
export interface Conversion {
  /** The amount asked for, in the source currency. */
  from: Money;
  /** The result, rounded once to the target's minor unit. */
  amount: Money;
  /**
   * Target units per source unit (`amount ÷ from`), rounded half-up to
   * RATE_SCALE decimals: to show and store. The amount comes from the exact
   * ratio of the two legs, not from this rounded rate.
   */
  rate: string;
  /** The day of the rates used: the newest on or before the day asked. */
  rateDate: string;
  /** Whose rates: `ecb`; `identity` for a conversion to the same currency. */
  source: string;
  /** The currency both legs are quoted against (EUR). */
  base: string;
  /** Units of the source and target currency per one `base` (`1` for the base itself). */
  legs: { from: string; to: string };
  rounding: RoundingMode;
}

/** The rates of one day. */
export interface RatesSnapshot {
  source: string;
  base: string;
  day: string;
  /** Units of each currency per one `base`, as stored. */
  rates: Record<string, string>;
}

/** Today in UTC, yyyy-mm-dd. */
export const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * `amount` in `to`, through the base both rates are quoted against: the
 * amount is multiplied by `toRate / fromRate`, computed as one exact
 * fraction, and rounded once to the target's minor unit (no intermediate
 * rounding of the base amount). Pure, for tests and callers holding rates.
 */
export function crossConvert(
  amount: Money,
  to: string,
  fromRate: string,
  toRate: string,
  rounding: RoundingMode = 'half-up',
): { amount: Money; rate: string } {
  const target = currency(to);
  const f = toDecimal(fromRate);
  const t = toDecimal(toRate);
  if (f.units <= 0n || t.units <= 0n) {
    throw new RangeError('Exchange rates must be above zero');
  }
  const shift = Money.zero(target).exponent - amount.exponent;
  // minor_to = minor_from × 10^shift × (t.units / 10^t.scale) / (f.units / 10^f.scale)
  let numerator = amount.minor * t.units * pow10(f.scale);
  let denominator = f.units * pow10(t.scale);
  if (shift >= 0) {
    numerator *= pow10(shift);
  } else {
    denominator *= pow10(-shift);
  }
  const rate = divideRounded(
    t.units * pow10(f.scale + RATE_SCALE),
    f.units * pow10(t.scale),
    'half-up',
  );
  return {
    amount: Money.ofMinor(
      divideRounded(numerator, denominator, rounding),
      target,
    ),
    rate: normalizeDecimal(formatDecimal(rate, RATE_SCALE)),
  };
}

/**
 * Exchange rates: stores the days ExchangeRatesJob fetches, gives a day's
 * rates, and converts amounts between currencies by triangulation through
 * the base (EUR for the ECB): USD → JPY is USD → EUR → JPY, with the two
 * legs of the same day. A day without rates (a weekend, a TARGET holiday)
 * takes the newest day before it, and the result says which day it took.
 */
@Injectable()
export class ExchangeRatesService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(private readonly txHost: TransactionHost<DrizzleTransactions>) {}

  /** The newest day stored for `source`, or null before the first fetch. */
  async newestDay(source: string = ECB.source): Promise<string | null> {
    const [row] = await this.db
      .select({ day: max(exchangeRates.day) })
      .from(exchangeRates)
      .where(eq(exchangeRates.source, source));
    return row?.day ?? null;
  }

  /** The rates of the newest day on or before `day` (default today, UTC), or null when none is stored. */
  async ratesOn(
    day: string = utcToday(),
    source: string = ECB.source,
  ): Promise<RatesSnapshot | null> {
    const [found] = await this.db
      .select({ day: max(exchangeRates.day) })
      .from(exchangeRates)
      .where(
        and(eq(exchangeRates.source, source), lte(exchangeRates.day, day)),
      );
    if (!found?.day) {
      return null;
    }
    const rows = await this.db
      .select({
        base: exchangeRates.base,
        currency: exchangeRates.currency,
        rate: exchangeRates.rate,
      })
      .from(exchangeRates)
      .where(
        and(eq(exchangeRates.source, source), eq(exchangeRates.day, found.day)),
      )
      .orderBy(exchangeRates.currency);
    return {
      source,
      base: rows[0]?.base ?? ECB.base,
      day: found.day,
      rates: Object.fromEntries(rows.map((row) => [row.currency, row.rate])),
    };
  }

  /**
   * `amount` in `to` at the rates of `day` (default today, UTC): the newest
   * day on or before it that has both currencies. Rounded once, by
   * `rounding` (default half-up). A RateUnavailableError when no stored day
   * has them (a currency the ECB doesn't publish, or no rates fetched yet).
   */
  async convert(
    amount: Money,
    to: string,
    {
      day = utcToday(),
      rounding = 'half-up',
      source = ECB.source,
      base = ECB.base,
    }: {
      day?: string;
      rounding?: RoundingMode;
      source?: string;
      base?: string;
    } = {},
  ): Promise<Conversion> {
    const target = currency(to);
    if (target === amount.currency) {
      return {
        from: amount,
        amount,
        rate: '1',
        rateDate: day,
        source: 'identity',
        base: target,
        legs: { from: '1', to: '1' },
        rounding,
      };
    }
    const needed = [amount.currency, target].filter((code) => code !== base);
    const [found] = await this.db
      .select({ day: exchangeRates.day })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.source, source),
          eq(exchangeRates.base, base),
          lte(exchangeRates.day, day),
          inArray(exchangeRates.currency, needed),
        ),
      )
      .groupBy(exchangeRates.day)
      .having(eq(count(), needed.length))
      .orderBy(desc(exchangeRates.day))
      .limit(1);
    if (!found) {
      throw new RateUnavailableError(needed, day, source);
    }
    const rows = await this.db
      .select({ currency: exchangeRates.currency, rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.source, source),
          eq(exchangeRates.day, found.day),
          inArray(exchangeRates.currency, needed),
        ),
      );
    const rateOf = (code: string) =>
      code === base ? '1' : rows.find((row) => row.currency === code)!.rate;
    const legs = { from: rateOf(amount.currency), to: rateOf(target) };
    const converted = crossConvert(
      amount,
      target,
      legs.from,
      legs.to,
      rounding,
    );
    return {
      from: amount,
      amount: converted.amount,
      rate: converted.rate,
      rateDate: found.day,
      source,
      base,
      legs,
      rounding,
    };
  }

  /**
   * Stores fetched days (insert, or update a corrected rate). One
   * transaction: a document is stored whole or not at all. Returns the
   * rows written: new ones and corrected ones, not those already stored as
   * they are.
   */
  async store(
    days: readonly RatesOfDay[],
    { source, base }: { source: string; base: string } = ECB,
  ): Promise<number> {
    const rows = days.flatMap(({ day, rates }) =>
      Object.entries(rates).map(([code, rate]) => ({
        source,
        base,
        day,
        currency: code,
        rate,
      })),
    );
    return inTransaction(this.txHost, async () => {
      let written = 0;
      // In batches: a parameter list has its limits.
      for (let start = 0; start < rows.length; start += 1000) {
        const changed = await this.db
          .insert(exchangeRates)
          .values(rows.slice(start, start + 1000))
          .onConflictDoUpdate({
            target: [
              exchangeRates.source,
              exchangeRates.day,
              exchangeRates.currency,
            ],
            set: {
              rate: sql`excluded.rate`,
              base: sql`excluded.base`,
              updatedAt: new Date(),
            },
            // Only a changed rate is a write (an hourly refetch of the same day is none).
            setWhere: sql`${exchangeRates.rate} <> excluded.rate or ${exchangeRates.base} <> excluded.base`,
          })
          .returning({ id: exchangeRates.id });
        written += changed.length;
      }
      return written;
    });
  }
}
