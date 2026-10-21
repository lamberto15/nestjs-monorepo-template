import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { StorageDisk } from '@nestjs/storage';
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { ATTACHMENT_SWEEP_JOB } from '../platform.jobs.js';
import { AttachmentScanQueue } from './attachment-scan.queue.js';
import { AttachmentsRegistry } from './attachments.registry.js';
import { attachments } from './attachments.tables.js';

/** Attachments looked at per round. */
const BATCH = 1000;

/**
 * Deletes the attachments of records that no longer exist, file and row:
 * records deleted for good (a note purged from the recycle bin by
 * SoftDeletePurgeJob, at 03:45). Every night at 04:05 in APP_TIMEZONE, on
 * one instance. Each registered target says which of its records still
 * exist (`exists()`); attachments of a subject no target registers any
 * more are left alone. As the system principal (`system:attachment-sweep`),
 * one tenant at a time (docs/tenancy.md: `Tenancy.forEachTenant()`, which
 * logs each): a target's `exists()` and the rows are that tenant's, and
 * each round's rows go with an `attachments.swept` audit entry in its log.
 */
@Injectable()
export class AttachmentSweepJob {
  private readonly logger = new Logger(AttachmentSweepJob.name);

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly disk: StorageDisk,
    private readonly registry: AttachmentsRegistry,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
    private readonly scans: AttachmentScanQueue,
  ) {}

  @Cron('5 4 * * *', {
    name: 'attachment-sweep',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:attachment-sweep' })
  @WithoutOverlapping()
  async run() {
    // Deactivated tenants too: their orphans' files still go.
    const swept = await this.tenancy.forEachTenant(
      ATTACHMENT_SWEEP_JOB.key,
      (tenant) => this.sweep(tenant.id),
      { includeInactive: true },
    );
    return [...swept.values()].reduce((sum, deleted) => sum + deleted, 0);
  }

  /**
   * Queues again the scans that never finished: an upload still pending an
   * hour on (its job was lost, or every attempt failed while the scanner
   * was away). A job of its own name per night, so a failed job BullMQ
   * still keeps doesn't block it. Nothing while scanning is off.
   */
  private async requeueScans() {
    if (!this.scans.enabled) return;
    const stale = await this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.scanStatus, 'pending'),
          lt(attachments.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      )
      .limit(BATCH);
    const night = new Date().toISOString().slice(0, 10);
    for (const { id } of stale) {
      await this.scans.enqueue(id, night);
    }
  }

  /** One tenant's orphans (run in its scope). */
  private sweep(tenantId: string) {
    return this.system.run(
      ATTACHMENT_SWEEP_JOB,
      async (system) => {
        let deleted = 0;
        for (const target of this.registry.all()) {
          let cursor: string | undefined;
          for (;;) {
            const rows = await this.db
              .select({
                id: attachments.id,
                recordId: attachments.recordId,
                key: attachments.key,
              })
              .from(attachments)
              .where(
                and(
                  eq(attachments.subject, target.subject),
                  cursor ? gt(attachments.id, cursor) : undefined,
                ),
              )
              .orderBy(asc(attachments.id))
              .limit(BATCH);
            if (rows.length === 0) break;
            cursor = rows[rows.length - 1]!.id;
            const existing = new Set(
              await target.exists([
                ...new Set(rows.map((row) => row.recordId)),
              ]),
            );
            const orphans = rows.filter((row) => !existing.has(row.recordId));
            if (orphans.length === 0) continue;
            // The files first: a failure leaves the rows, and the next night tries again.
            await this.disk.delete(orphans.map((row) => row.key));
            await inTransaction(this.txHost, async (tx) => {
              await tx.delete(attachments).where(
                inArray(
                  attachments.id,
                  orphans.map((row) => row.id),
                ),
              );
              await this.audit.record(
                system,
                {
                  action: 'attachments.swept',
                  targetType: 'attachment',
                  details: {
                    subject: target.subject,
                    attachments: orphans.map((row) => row.id),
                    records: [...new Set(orphans.map((row) => row.recordId))],
                  },
                },
                tx,
              );
            });
            deleted += orphans.length;
          }
        }
        await this.requeueScans();
        this.logger.log('Attachments of deleted records removed', {
          tenant: tenantId,
          deleted,
        });
        return deleted;
      },
      { transaction: false },
    );
  }
}
