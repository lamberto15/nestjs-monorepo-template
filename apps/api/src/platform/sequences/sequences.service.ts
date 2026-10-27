import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { and, eq, or, sql } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { sequences } from './sequences.tables.js';

export interface NextNumberOptions {
  /** Numbered apart: a unit's id, a client's key… Default: one series. */
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
 * no gaps: a UUID has none to pay). Every series is a tenant's
 * (docs/tenancy.md): tenant A's `NOTE-2026-00001` and tenant B's are two
 * numbers, and neither tenant learns how many the other took.
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
        // Per tenant: each numbers its own series (the row's tenant_id is
        // the context's, and the policies keep the others' rows apart).
        target: [sequences.tenantId, sequences.name, sequences.scope],
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

  /**
   * The next value of a naming series' counter (`key`: what its pattern
   * prints around the counter, naming-pattern.ts), in `tx`, locked until
   * the commit like `next()`. `carryFrom`: the scope of the counter a
   * declared format used before naming series; a key's first number
   * continues from it, so `NOTE-2026-00042` is followed by `00043`, never
   * by a second `00001`.
   */
  async take(
    tx: Transaction,
    name: string,
    key: string,
    { carryFrom }: { carryFrom?: string } = {},
  ) {
    const first = carryFrom
      ? sql`1 + coalesce((select ${sequences.value} from ${sequences} where ${and(eq(sequences.name, name), eq(sequences.scope, carryFrom))}), 0)`
      : 1;
    const [row] = await tx
      .insert(sequences)
      .values({ name, scope: key, value: first })
      .onConflictDoUpdate({
        target: [sequences.tenantId, sequences.name, sequences.scope],
        set: { value: sql`${sequences.value} + 1` },
      })
      .returning({ value: sequences.value });
    return Number(row!.value);
  }

  /** Reserves a contiguous range for one counter key with a single UPSERT. */
  async takeMany(
    tx: Transaction,
    name: string,
    key: string,
    count: number,
    { carryFrom }: { carryFrom?: string } = {},
  ) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError('A sequence batch needs a positive integer count.');
    }
    const first = carryFrom
      ? sql`1 + coalesce((select ${sequences.value} from ${sequences} where ${and(eq(sequences.name, name), eq(sequences.scope, carryFrom))}), 0)`
      : 1;
    const [row] = await tx
      .insert(sequences)
      .values({ name, scope: key, value: sql`${first} + ${count - 1}` })
      .onConflictDoUpdate({
        target: [sequences.tenantId, sequences.name, sequences.scope],
        set: { value: sql`${sequences.value} + ${count}` },
      })
      .returning({ value: sequences.value });
    const last = Number(row!.value);
    return Array.from(
      { length: count },
      (_, index) => last - count + index + 1,
    );
  }

  /** A naming series counter's last value (0 when none), `carryFrom` as in `take()`. */
  async peek(name: string, key: string, options: { carryFrom?: string } = {}) {
    const [value] = await this.peekMany([{ name, key, ...options }]);
    return value!;
  }

  /** `peek()` of many counters, in one query: their values in order. */
  async peekMany(
    counters: readonly { name: string; key: string; carryFrom?: string }[],
  ) {
    const wanted = counters.flatMap(({ name, key, carryFrom }) =>
      [key, carryFrom]
        .filter((scope) => scope !== undefined)
        .map((scope) =>
          and(eq(sequences.name, name), eq(sequences.scope, scope)),
        ),
    );
    const rows = wanted.length
      ? await this.db
          .select({
            name: sequences.name,
            scope: sequences.scope,
            value: sequences.value,
          })
          .from(sequences)
          .where(or(...wanted))
      : [];
    const valueOf = (name: string, scope?: string) =>
      rows.find((row) => row.name === name && row.scope === scope)?.value;
    return counters.map(({ name, key, carryFrom }) =>
      Number(valueOf(name, key) ?? valueOf(name, carryFrom) ?? 0),
    );
  }

  /**
   * Sets a naming series counter's last value, in `tx`: the next number is
   * `value + 1`. Never below the last value taken (a number is never given
   * twice): `set: false`, and nothing changed, when it would be. `before`:
   * the last value taken.
   */
  async setAtLeast(
    tx: Transaction,
    name: string,
    key: string,
    value: number,
    { carryFrom }: { carryFrom?: string } = {},
  ) {
    // The row's lock first: a number taken meanwhile is counted.
    const [locked] = await tx
      .select({ value: sequences.value })
      .from(sequences)
      .where(and(eq(sequences.name, name), eq(sequences.scope, key)))
      .for('update');
    const current = locked
      ? Number(locked.value)
      : await this.peek(name, key, { carryFrom });
    if (value < current) {
      return { set: false, before: current };
    }
    const [row] = await tx
      .insert(sequences)
      .values({ name, scope: key, value })
      .onConflictDoUpdate({
        target: [sequences.tenantId, sequences.name, sequences.scope],
        set: { value },
        // Taken by a write that committed between the two statements.
        setWhere: sql`${sequences.value} <= ${value}`,
      })
      .returning({ value: sequences.value });
    return { set: row !== undefined, before: current };
  }

  /** The year of a moment in APP_TIMEZONE: a series restarts at the app's new year. */
  private yearOf(at: Date) {
    return new Intl.DateTimeFormat('en', {
      timeZone: this.config.get('APP_TIMEZONE', { infer: true }),
      year: 'numeric',
    }).format(at);
  }
}
