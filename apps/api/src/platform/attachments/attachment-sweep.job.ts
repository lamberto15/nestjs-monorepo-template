import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { StorageDisk } from '@nestjs/storage';
import { and, asc, eq, gt, inArray, lt, notExists } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { SystemPrincipal } from '../../iam/auth/principal.js';
import { renditionKeys } from '../images/renditions.js';
import { ATTACHMENT_SWEEP_JOB } from '../platform.jobs.js';
import {
  UPLOAD_GRACE_MS,
  uploadObjects,
} from './attachment-uploads.service.js';
import { AttachmentsRegistry } from './attachments.registry.js';
import {
  attachments,
  attachmentUploads,
  attachmentVersions,
} from './attachments.tables.js';

/** Attachments looked at per round. */
const BATCH = 1000;

/**
 * Deletes the attachments of records that no longer exist, file and row:
 * records deleted for good (a note purged from the recycle bin by
 * SoftDeletePurgeJob, at 03:45). Every night at 04:05 in APP_TIMEZONE, on
 * one instance. Each registered target says which of its records still
 * exist (`records`, a `NOT EXISTS` anti-join in the database); attachments of a subject no target registers any
 * more are left alone. As the system principal (`system:attachment-sweep`),
 * one tenant at a time (docs/tenancy.md: `Tenancy.forEachTenant()`, which
 * logs each): a target's record table and the rows are that tenant's, and
 * each round's rows go with an `attachments.swept` audit entry in its log.
 *
 * It also deletes the objects of direct uploads that were announced and
 * never completed (`attachment_uploads`, STORAGE_DRIVER=s3): an hour after
 * their URL expired, with their rows and an `attachments.uploads-swept`
 * audit entry. The rows of completed uploads go the same way, without an
 * entry, with what was PUT to their URL after the completion (the
 * attachment is a copy on another key). An object an attachment has as its
 * file is never deleted here.
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

  /** One tenant's orphans (run in its scope). */
  private sweep(tenantId: string) {
    return this.system.run(
      ATTACHMENT_SWEEP_JOB,
      async (system) => {
        let deleted = 0;
        for (const target of this.registry.all()) {
          let cursor: string | undefined;
          for (;;) {
            const { table, id } = target.records;
            const orphans = await this.db
              .select({
                id: attachments.id,
                recordId: attachments.recordId,
                key: attachments.key,
                renditions: attachments.renditions,
              })
              .from(attachments)
              .where(
                and(
                  eq(attachments.subject, target.subject),
                  cursor ? gt(attachments.id, cursor) : undefined,
                  notExists(
                    this.db
                      .select({ one: id })
                      .from(table)
                      .where(eq(id, attachments.recordId)),
                  ),
                ),
              )
              .orderBy(asc(attachments.id))
              .limit(BATCH);
            if (orphans.length === 0) break;
            cursor = orphans[orphans.length - 1]!.id;
            // The files first: a failure leaves the rows, and the next night tries again.
            const versions = await this.db
              .select({ key: attachmentVersions.key })
              .from(attachmentVersions)
              .where(
                inArray(
                  attachmentVersions.attachmentId,
                  orphans.map((row) => row.id),
                ),
              );
            await this.disk.delete([
              ...orphans.flatMap((row) => [
                row.key,
                ...renditionKeys(row.renditions),
              ]),
              ...versions.map((version) => version.key),
            ]);
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
        this.logger.log('Attachments of deleted records removed', {
          tenant: tenantId,
          deleted,
        });
        const abandoned = await this.sweepUploads(system);
        if (abandoned > 0) {
          this.logger.log('Direct uploads never completed removed', {
            tenant: tenantId,
            deleted: abandoned,
          });
        }
        return deleted + abandoned;
      },
      { transaction: false },
    );
  }

  /**
   * The direct uploads (this tenant's) whose URL expired more than
   * UPLOAD_GRACE_MS ago: the object, then the row. Returns how many nobody
   * completed (a completed upload's object is only what was PUT again).
   */
  private async sweepUploads(system: SystemPrincipal): Promise<number> {
    let deleted = 0;
    for (;;) {
      const expired = await this.db
        .select({
          id: attachmentUploads.id,
          key: attachmentUploads.key,
          resumable: attachmentUploads.resumable,
          completedAt: attachmentUploads.completedAt,
        })
        .from(attachmentUploads)
        .where(
          lt(
            attachmentUploads.expiresAt,
            new Date(Date.now() - UPLOAD_GRACE_MS),
          ),
        )
        .orderBy(asc(attachmentUploads.id))
        .limit(BATCH);
      if (expired.length === 0) break;
      // A key that became an attachment's file is not an orphan: keep its object.
      const used = new Set(
        (
          await this.db
            .select({ key: attachments.key })
            .from(attachments)
            .where(
              inArray(
                attachments.key,
                expired.map((row) => row.key),
              ),
            )
        ).map((row) => row.key),
      );
      const abandoned = expired.filter((row) => !row.completedAt);
      // The objects first: a failure leaves the rows, and the next night tries again.
      await this.disk.delete(
        (
          await Promise.all(
            // The parts of a resumable session go with it.
            expired.map((row) => uploadObjects(this.disk, row)),
          )
        )
          .flat()
          .filter((key) => !used.has(key)),
      );
      await inTransaction(this.txHost, async (tx) => {
        await tx.delete(attachmentUploads).where(
          inArray(
            attachmentUploads.id,
            expired.map((row) => row.id),
          ),
        );
        if (abandoned.length > 0) {
          await this.audit.record(
            system,
            {
              action: 'attachments.uploads-swept',
              targetType: 'attachment',
              details: { uploads: abandoned.map((row) => row.id) },
            },
            tx,
          );
        }
      });
      deleted += abandoned.length;
    }
    return deleted;
  }
}
