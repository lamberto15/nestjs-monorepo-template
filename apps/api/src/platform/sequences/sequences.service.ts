import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { sequences } from './sequences.tables.js';

export interface NextNumberOptions {
  /** Numbered apart: an org unit's id, a client's key… Default: one series. */
  scope?: string;
  /** Starts over every year, the year in the number: `INV-2026-00042`. */
  perYear?: boolean;
  /** The moment the number is for (its year); default now. */
  at?: Date;
  /** `INV` in `INV-2026-00042`. */
  prefix?: string;
  /** Digits, zero-padded: 5 for `00042`. Default: none. */
  width?: number;
  /** Between the parts; default `-`. */
  separator?: string;
}

/** The parts of a number as text: prefix, year, the value padded. */
export function formatNumber(
  value: number,
  { prefix, width, separator = '-' }: NextNumberOptions,
  year?: string,
) {
  const digits = width ? String(value).padStart(width, '0') : String(value);
  return [prefix, year, digits].filter(Boolean).join(separator);
}

/**
 * Gapless, human-readable numbers (`INV-2026-00042`), for any record a
 * feature numbers: one counter per sequence and scope, taken in the
 * write's transaction. The counter's row is locked until the commit, so
 * two writes never get the same number and a rollback leaves no gap; a
 * busy series serializes its writes on that row (that is the price of
 * no gaps: a UUID has none to pay).
 *
 * ```ts
 * const { formatted } = await this.sequences.next(tx, 'note', { prefix: 'NOTE', perYear: true, width: 5 });
 * ```
 */
@Injectable()
export class SequencesService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  /** The next number of `name` (and scope), in `tx`: its value, and as text. */
  async next(tx: Transaction, name: string, options: NextNumberOptions = {}) {
    const year = options.perYear
      ? this.yearOf(options.at ?? new Date())
      : undefined;
    const scope = [options.scope ?? '', year ?? ''].join('|');
    const [row] = await tx
      .insert(sequences)
      .values({ name, scope, value: 1 })
      .onConflictDoUpdate({
        target: [sequences.name, sequences.scope],
        set: { value: sql`${sequences.value} + 1` },
      })
      .returning({ value: sequences.value });
    const value = Number(row!.value);
    return { value, formatted: formatNumber(value, options, year) };
  }

  /** The last number taken (0 when none): for display, never to number with. */
  async current(
    name: string,
    options: Pick<NextNumberOptions, 'scope' | 'perYear' | 'at'> = {},
  ) {
    const year = options.perYear
      ? this.yearOf(options.at ?? new Date())
      : undefined;
    const scope = [options.scope ?? '', year ?? ''].join('|');
    const [row] = await this.db
      .select({ value: sequences.value })
      .from(sequences)
      .where(and(eq(sequences.name, name), eq(sequences.scope, scope)));
    return Number(row?.value ?? 0);
  }

  /** The year of a moment in APP_TIMEZONE: a series restarts at the app's new year. */
  private yearOf(at: Date) {
    return new Intl.DateTimeFormat('en', {
      timeZone: this.config.get('APP_TIMEZONE', { infer: true }),
      year: 'numeric',
    }).format(at);
  }
}
