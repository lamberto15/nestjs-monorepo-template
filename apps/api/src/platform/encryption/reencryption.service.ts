import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { DecryptionError } from '../../core/encryption/data-cipher.js';
import {
  type EncryptedColumn,
  encryptedColumns,
} from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { REENCRYPTION_JOB } from '../platform.jobs.js';

/** The re-encryption queue (platform/queues/queues.ts). */
export const REENCRYPTION = 'reencryption';

/** Rows read and rewritten per job: short transactions, short locks. */
export const REENCRYPTION_BATCH = 500;

/** One batch of one column in one tenant (`null`: a table of no tenant). */
export interface ReencryptionJob extends TenantEnvelope {
  /** The column, as `table.column` (its binding: encrypted-columns.ts). */
  column: string;
  /** The last id the previous batch read: the next one starts after it. */
  after?: string;
}

/** What one batch did. */
export interface ReencryptionBatch {
  /** Rows rewritten under the current keys. */
  rewritten: number;
  /** Rows changed by someone else between the read and the write: their write used the current key. */
  skipped: number;
  /** Rows that didn't open (a key removed too early): left as they are, and counted by the metric. */
  failed: number;
  /** Where the next batch starts; undefined when this one was the last. */
  next?: string;
}

/**
 * The re-encryption job (roadmap item 5, docs/encryption.md): rewrites the
 * values of encrypted columns (and their blind indexes) still under an
 * older key with the current one, so the old key can leave
 * DATA_ENCRYPTION_KEYS (or BLIND_INDEX_KEYS). Heavy work, so never in a
 * request: the hourly ReencryptionScheduler queues one job per tenant and
 * column that has stale rows, and each job does one batch and queues the
 * next.
 *
 * - **Chunked and resumable:** batches of REENCRYPTION_BATCH rows in id
 *   order, the next starting after the last id; a job that dies is retried
 *   by the queue, and a stale row is stale until rewritten, so the next
 *   schedule finds whatever is left.
 * - **Tolerates concurrent writes:** each row is written back only where it
 *   still holds the value read (`… WHERE id = $1 AND column = <old value>`),
 *   so a value changed in between (by a request, under the current key)
 *   is never overwritten with the old one.
 * - **Measured:** `encrypted_rows_on_old_key` (ReencryptionMetrics); the
 *   old key leaves only when it reads 0.
 *
 * It changes no value anyone sees, so it records no audit entry or
 * revision; the batches are logged.
 */
@Injectable()
export class ReencryptionService {
  private readonly logger = new Logger('Reencryption');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly encryption: EncryptionService,
    private readonly tenancy: Tenancy,
    @InjectQueue(REENCRYPTION)
    private readonly queue: Queue<ReencryptionJob>,
  ) {}

  /**
   * Queues a first batch for every tenant and column with stale rows (and
   * every table of no tenant): what the scheduler runs. Returns how many
   * jobs it queued.
   */
  async schedule(): Promise<number> {
    const columns = encryptedColumns();
    const scoped = columns.filter((entry) => entry.tenantScoped);
    const global = columns.filter((entry) => !entry.tenantScoped);
    let queued = 0;
    if (scoped.length > 0) {
      const perTenant = await this.tenancy.forEachTenant(
        REENCRYPTION_JOB.key,
        (tenant) => this.queueStale(scoped, tenant.id),
        // A deactivated tenant's rows still hold the old key.
        { includeInactive: true },
      );
      for (const count of perTenant.values()) {
        queued += count;
      }
    }
    if (global.length > 0) {
      queued += await this.tenancy.none(() => this.queueStale(global, null));
    }
    if (queued > 0) {
      this.logger.log(`Re-encryption queued for ${queued} column(s)`);
    }
    return queued;
  }

  /** How many rows of `entry` in the current scope are stale. */
  async countStale(entry: EncryptedColumn): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(entry.table)
      .where(this.stale(entry));
    return row?.count ?? 0;
  }

  /**
   * One batch of `entry` in the current tenant (or none, for a global
   * table): the stale rows after `after`, rewritten under the current
   * keys, each only where it still holds what was read.
   */
  async batch(
    entry: EncryptedColumn,
    after?: string,
  ): Promise<ReencryptionBatch> {
    const tenantId = entry.tenantScoped ? currentTenantId() : null;
    const index = entry.blindIndex?.column;
    const rows = await this.db
      .select({
        id: sql<string>`${entry.id}`,
        value: sql<string>`${entry.column}`,
      })
      .from(entry.table)
      .where(
        and(
          this.stale(entry),
          after === undefined ? undefined : gt(entry.id, after),
        ),
      )
      .orderBy(asc(entry.id))
      .limit(REENCRYPTION_BATCH);
    const result: ReencryptionBatch = { rewritten: 0, skipped: 0, failed: 0 };
    if (rows.length === 0) {
      return result;
    }
    await inTransaction(this.txHost, async (tx) => {
      for (const row of rows) {
        let rewritten: { value: string; index?: string };
        try {
          rewritten = this.encryption.rewrite(entry, row.value, tenantId);
        } catch (error) {
          if (!(error instanceof DecryptionError)) {
            throw error;
          }
          // Never the value: the column, the row and why.
          this.logger.warn('An encrypted value did not open', {
            column: `${entry.bindingTable}.${entry.bindingColumn}`,
            id: row.id,
            reason: error.reason,
          });
          result.failed++;
          continue;
        }
        const changed = await tx
          .update(entry.table as PgTable)
          .set({
            [entry.key]: rewritten.value,
            ...(entry.blindIndex && {
              [entry.blindIndex.key]: rewritten.index,
            }),
          })
          .where(and(eq(entry.id, row.id), eq(entry.column, row.value)))
          .returning({ id: sql<string>`${entry.id}` });
        if (changed.length > 0) {
          result.rewritten++;
        } else {
          result.skipped++;
        }
      }
    });
    if (rows.length === REENCRYPTION_BATCH) {
      result.next = rows[rows.length - 1].id;
    }
    this.logger.log('Re-encryption batch', {
      column: `${entry.bindingTable}.${entry.bindingColumn}`,
      tenant: tenantId,
      ...result,
      blindIndex: index !== undefined,
    });
    return result;
  }

  /** Queues the next batch of a job's column (after its last id). */
  queueNext(job: ReencryptionJob, after: string) {
    return this.queue.add('batch', { ...job, after });
  }

  /** The rows of `entry` not in today's format under the current keys. */
  stale(entry: EncryptedColumn): SQL {
    const prefix = this.encryption.currentPrefix() ?? '';
    const indexPrefix = this.encryption.currentIndexPrefix() ?? '';
    const index = entry.blindIndex?.column;
    // starts_with, not LIKE: key ids are base64url, and `_` is LIKE's wildcard.
    return and(
      isNotNull(entry.column),
      or(
        not(sql`starts_with(${entry.column}, ${prefix})`),
        index === undefined
          ? undefined
          : or(isNull(index), not(sql`starts_with(${index}, ${indexPrefix})`)),
      ),
    ) as SQL;
  }

  private async queueStale(
    columns: readonly EncryptedColumn[],
    tenantId: string | null,
  ) {
    let queued = 0;
    for (const entry of columns) {
      if ((await this.countStale(entry)) === 0) {
        continue;
      }
      await this.queue.add('batch', {
        tenantId,
        column: `${entry.bindingTable}.${entry.bindingColumn}`,
      });
      queued++;
    }
    return queued;
  }
}
