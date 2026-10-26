import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { Database } from '../../core/database/drizzle.js';

export type OutboxMetricSnapshot = {
  pending: number;
  deadLetters: number;
  oldestDueAt: number | null;
};

/** A small process-local cache: concurrent scrapes share a read, and successful results live for 30 seconds. */
export class MetricSnapshot<T> {
  private cached?: { value: T; at: number };
  private pending?: Promise<T>;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly now = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  get(): Promise<T> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) {
      return Promise.resolve(this.cached.value);
    }
    if (this.pending) return this.pending;
    const pending = this.read().then((value) => {
      this.cached = { value, at: this.now() };
      return value;
    });
    this.pending = pending;
    void pending.then(
      () => {
        if (this.pending === pending) this.pending = undefined;
      },
      () => {
        if (this.pending === pending) this.pending = undefined;
      },
    );
    return pending;
  }
}

/**
 * OutboxRelay.stats() also computes the exact claimable count using a window
 * over every queued message. Metrics need only three aggregate values, so
 * use one bounded, read-only statement instead. Its CASE matches the relay's
 * stats() rule: retries age from created_at; first attempts age from due time.
 */
@Injectable()
export class OutboxMetricsReader {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async read(): Promise<OutboxMetricSnapshot> {
    const result = await this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        return tx.execute(sql`
          SELECT
            (SELECT count(*) FROM nest_outbox.messages)::text AS pending,
            (SELECT count(*) FROM nest_outbox.dead_letters)::text AS dead_letters,
            (SELECT min(CASE
              WHEN attempts > 0 THEN created_at
              WHEN available_at <= (extract(epoch FROM statement_timestamp()) * 1000)::bigint THEN available_at
            END) FROM nest_outbox.messages)::text AS oldest_due_at
        `);
      },
      { accessMode: 'read only' },
    );
    const row = result.rows[0] as
      | { pending: string; dead_letters: string; oldest_due_at: string | null }
      | undefined;
    if (!row) throw new Error('Outbox metrics query returned no row');
    return {
      pending: Number(row.pending),
      deadLetters: Number(row.dead_letters),
      oldestDueAt:
        row.oldest_due_at === null ? null : Number(row.oldest_due_at),
    };
  }
}
