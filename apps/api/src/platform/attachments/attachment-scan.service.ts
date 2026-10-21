import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk } from '@nestjs/storage';
import { and, eq } from 'drizzle-orm';
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
import type { AttachmentScanJob } from './attachment-scan.queue.js';
import { AttachmentsService } from './attachments.service.js';
import { type Attachment, attachments } from './attachments.tables.js';
import { MalwareScanner } from './malware-scanner.js';

/** How a scan ended, as `attachments_scanned_total{result}` counts it. */
export type ScanOutcome = 'clean' | 'infected' | 'error';

/**
 * The malware scan of uploads (MALWARE_SCANNER, docs/attachments.md). An
 * upload is `pending` until a queue job (on a worker) streams its file to
 * the scanner: clean, it becomes `clean`; infected, the attachment is
 * deleted (row and file), audited `attachment.rejected` by the system
 * principal `system:attachment-scan`, and the uploader is notified
 * (`attachment.rejected`). A scanner that fails leaves it pending and the
 * job is tried again; a file is never clean without a scan.
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

  private async reject(
    row: Attachment,
    signature: string,
    system: Parameters<AttachmentsService['changed']>[0],
  ) {
    const removed = await inTransaction(this.txHost, async (tx) => {
      const [gone] = await tx
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
      this.attachments.changed(system, row, row.id, 'removed');
    }
  }
}
