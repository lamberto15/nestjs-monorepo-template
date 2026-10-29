import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk } from '@nestjs/storage';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { Counter } from 'prom-client';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ATTACHMENT_SCAN_JOB } from '../platform.jobs.js';
import { AttachmentImagesQueue } from './attachment-images.queue.js';
import {
  type AttachmentScanJob,
  AttachmentScanQueue,
} from './attachment-scan.queue.js';
import { AttachmentVersionsService } from './attachment-versions.service.js';
import { AttachmentsService } from './attachments.service.js';
import { type Attachment, attachments } from './attachments.tables.js';
import { MalwareScanner } from './malware-scanner.js';

/** How a scan ended, as `attachments_scanned_total{result}` counts it. */
export type ScanOutcome = 'clean' | 'infected' | 'error';

/**
 * How long an upload may stay pending before `retryPending()` queues its
 * scan again, and the retry job's period (AttachmentScanRetryJob, every five
 * minutes, which also names the jobs it queues: one per file per period).
 * The queue's own retries end about 75 s after the upload with the defaults
 * (MALWARE_SCAN_ATTEMPTS 5, backoff from 5 s).
 */
export const RETRY_MS = 5 * 60 * 1000;

/** Rows per round. */
const BATCH = 1000;

/**
 * The malware scan of uploads (MALWARE_SCANNER, docs/attachments.md). An
 * upload is `pending` until a queue job (on a worker) streams its file to
 * the scanner: clean, it becomes `clean`; infected, the attachment is
 * deleted (row and file), audited `attachment.rejected` by the system
 * principal `system:attachment-scan`, and the uploader is notified
 * (`attachment.rejected`). A scanner that fails leaves it pending and the
 * job is tried again; a file is never clean without a scan, unless scanning
 * is switched off (MALWARE_SCANNER=off), which releases what is pending.
 */
@Injectable()
export class AttachmentScanService {
  private readonly logger = new Logger('AttachmentScan');

  /** `attachments_scanned_total{result}`: clean, infected, or error (the scan failed; it is tried again). */
  private readonly scanned: Counter<'result'>;

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly scanner: MalwareScanner,
    private readonly disk: StorageDisk,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly attachments: AttachmentsService,
    private readonly versions: AttachmentVersionsService,
    private readonly queue: AttachmentScanQueue,
    private readonly images: AttachmentImagesQueue,
    metrics: MetricsService,
  ) {
    this.scanned = new Counter({
      name: 'attachments_scanned_total',
      help: 'Uploads scanned for malware, by result (clean, infected, error).',
      labelNames: ['result'] as const,
      registers: [metrics.registry],
    });
  }

  /**
   * Scans one attachment (the worker, in the job's tenant). Nothing to do
   * for one that is gone or already clean. Throws when the scanner fails,
   * so the queue tries again.
   */
  async scan(job: AttachmentScanJob): Promise<ScanOutcome | 'skipped'> {
    // Switched off after the upload: the scanner refuses every file, and
    // retryPending() releases what is pending. Not a failed scan to try again.
    if (!this.scanner.enabled) {
      return 'skipped';
    }
    return this.system.run(
      ATTACHMENT_SCAN_JOB,
      async (system) => {
        const [row] = await this.db
          .select()
          .from(attachments)
          .where(eq(attachments.id, job.attachmentId));
        if (!row || row.scanStatus !== 'pending') {
          return 'skipped';
        }
        let verdict;
        try {
          const file = await this.disk.get(row.key);
          verdict = await this.scanner.scan(file.body);
        } catch (error) {
          this.scanned.inc({ result: 'error' });
          throw error;
        }
        if (!verdict.infected) {
          const [clean] = await this.db
            .update(attachments)
            .set({ scanStatus: 'clean' })
            .where(
              and(
                eq(attachments.id, row.id),
                eq(attachments.scanStatus, 'pending'),
              ),
            )
            .returning({ id: attachments.id });
          if (clean) {
            this.scanned.inc({ result: 'clean' });
            this.attachments.changed(system, row, row.id, 'scanned');
            // An image is processed only once it may be served.
            if (row.renditionStatus === 'pending') {
              await this.images.enqueue(row.id);
            }
          }
          return 'clean';
        }
        await this.reject(row, verdict.signature, system);
        this.scanned.inc({ result: 'infected' });
        return 'infected';
      },
      { transaction: false, tenantId: job.tenantId },
    );
  }

  /**
   * What the queue's own retries and the best-effort enqueue after an upload
   * don't cover, for the current tenant (AttachmentScanRetryJob, every five
   * minutes, in each tenant's scope). Returns how many files it handled.
   * - Scanning on: queues again the scans of uploads still pending after
   *   `RETRY_MS` (clamd restarting, a lost or exhausted job), so an outage
   *   costs minutes, not a night.
   * - Scanning off (MALWARE_SCANNER switched back to `off` while uploads
   *   were pending): nothing will scan them, and they would stay pending
   *   and not downloadable for good. They are released as `clean`, as the
   *   files stored before scanning was switched on stay clean, and audited.
   */
  async retryPending(now = new Date()): Promise<number> {
    return this.system.run(
      ATTACHMENT_SCAN_JOB,
      async (system) => {
        if (!this.scanner.enabled) {
          return this.release(system);
        }
        const stale = await this.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            and(
              eq(attachments.scanStatus, 'pending'),
              lt(attachments.createdAt, new Date(now.getTime() - RETRY_MS)),
            ),
          )
          .orderBy(asc(attachments.createdAt))
          .limit(BATCH);
        const period = String(Math.floor(now.getTime() / RETRY_MS));
        for (const { id } of stale) {
          await this.queue.enqueue(id, period);
        }
        return stale.length;
      },
      { transaction: false },
    );
  }

  /** Scanning is off: the pending files become `clean` (a round of `BATCH` at a time), audited. */
  private async release(system: Parameters<AttachmentsService['changed']>[0]) {
    let released = 0;
    for (;;) {
      const rows = await inTransaction(this.txHost, async (tx) => {
        const done = await tx
          .update(attachments)
          .set({ scanStatus: 'clean' })
          .where(
            and(
              eq(attachments.scanStatus, 'pending'),
              inArray(
                attachments.id,
                tx
                  .select({ id: attachments.id })
                  .from(attachments)
                  .where(eq(attachments.scanStatus, 'pending'))
                  .orderBy(asc(attachments.createdAt))
                  .limit(BATCH),
              ),
            ),
          )
          .returning();
        if (done.length > 0) {
          await this.audit.record(
            system,
            {
              action: 'attachments.released',
              targetType: 'attachment',
              details: {
                reason: 'scanner_off',
                attachments: done.map((row) => row.id),
              },
            },
            tx,
          );
        }
        return done;
      });
      for (const row of rows) {
        this.attachments.changed(system, row, row.id, 'scanned');
        if (row.renditionStatus === 'pending') {
          await this.images.enqueue(row.id);
        }
      }
      released += rows.length;
      if (rows.length < BATCH) {
        return released;
      }
    }
  }

  private async reject(
    row: Attachment,
    signature: string,
    system: Parameters<AttachmentsService['changed']>[0],
  ) {
    let reverted: Attachment | null = null;
    const removed = await inTransaction(this.txHost, async (tx) => {
      // A replacement that is infected gives the attachment back its previous
      // version (docs/attachments.md, "Versions"); only a first file is deleted.
      reverted =
        row.version > 1 ? await this.versions.revertRejected(tx, row) : null;
      const [gone] = reverted
        ? [reverted]
        : await tx
            .delete(attachments)
            .where(
              and(
                eq(attachments.id, row.id),
                eq(attachments.scanStatus, 'pending'),
              ),
            )
            .returning({ id: attachments.id });
      if (!gone) {
        return false; // removed by its uploader meanwhile: nothing to audit
      }
      await this.audit.record(
        system,
        {
          action: 'attachment.rejected',
          targetType: 'attachment',
          targetId: row.id,
          details: {
            subject: row.subject,
            recordId: row.recordId,
            name: row.name,
            size: row.size,
            contentType: row.contentType,
            uploadedBy: row.uploadedBy,
            signature,
          },
        },
        tx,
      );
      if (/^(user|client):/.test(row.uploadedBy)) {
        await this.notifications.notify(tx, {
          type: 'attachment.rejected',
          to: row.uploadedBy,
          data: { name: row.name, subject: row.subject, signature },
        });
      }
      return true;
    });
    // After the commit, as remove() does: a failed delete leaves a file nothing points at.
    await this.disk.delete(row.key).catch((error: unknown) =>
      this.logger.warn('An infected file was not deleted', {
        key: row.key,
        error: String(error),
      }),
    );
    if (removed) {
      this.logger.warn('An upload was rejected as malware', {
        attachment: row.id,
        signature,
      });
      const back = reverted as Attachment | null;
      this.attachments.changed(
        system,
        row,
        row.id,
        back ? 'processed' : 'removed',
      );
      if (back?.renditionStatus === 'pending') {
        await this.images.enqueue(back.id);
      }
    }
  }
}
