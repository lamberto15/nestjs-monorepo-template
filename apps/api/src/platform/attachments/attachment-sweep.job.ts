import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { StorageDisk } from '@nestjs/storage';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { ATTACHMENT_SWEEP_JOB } from '../platform.jobs.js';
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
 * more are left alone. As the system principal (`system:attachment-sweep`):
 * each round's rows go with an `attachments.swept` audit entry.
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
  ) {}

  @Cron('5 4 * * *', {
    name: 'attachment-sweep',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:attachment-sweep' })
  @WithoutOverlapping()
  run() {
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
        this.logger.log('Attachments of deleted records removed', { deleted });
        return deleted;
      },
      { transaction: false },
    );
  }
}
