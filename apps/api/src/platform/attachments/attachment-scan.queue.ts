import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import { z } from 'zod';
import { defineNotifications } from '../notifications/notification.types.js';
import type { PlatformEnv } from '../platform.env.js';
import { MalwareScanner } from './malware-scanner.js';

/** The queue of uploads to scan. */
export const ATTACHMENT_SCAN = 'attachment-scan';

/** What a queued scan carries: the attachment, and its tenant (docs/tenancy.md). */
export interface AttachmentScanJob extends TenantEnvelope {
  readonly tenantId: string;
  attachmentId: string;
}

/**
 * Queues the malware scans of uploads (MALWARE_SCANNER). Apart from
 * AttachmentScanService, which reads the attachments, so that the
 * attachments service can queue a scan without depending on it.
 */
@Injectable()
export class AttachmentScanQueue {
  private readonly logger = new Logger('AttachmentScan');

  constructor(
    @InjectQueue(ATTACHMENT_SCAN)
    private readonly queue: Queue<AttachmentScanJob>,
    private readonly scanner: MalwareScanner,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  /** Whether uploads are scanned: MALWARE_SCANNER is not `off`. */
  get enabled() {
    return this.scanner.enabled;
  }

  /**
   * Queues the scan of an attachment (in the current tenant's scope), after
   * the transaction that stored it committed. `again`: a name for the job
   * when AttachmentScanRetryJob queues a scan that never finished (a job id
   * is queued once, and a failed job is kept for a while). A failure is
   * logged, not thrown: the file stays pending and the retry job queues it
   * again within minutes.
   */
  async enqueue(attachmentId: string, again?: string) {
    try {
      await this.queue.add('scan', withTenant({ attachmentId }), {
        jobId: again ? `${attachmentId}-${again}` : attachmentId,
        attempts: this.config.get('MALWARE_SCAN_ATTEMPTS', { infer: true }),
        backoff: { type: 'exponential', delay: 5000 },
        // The retry job queues a pending file again every few minutes while
        // the scanner is away: keep the failures bounded (the queues' default
        // keeps them seven days).
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch (error) {
      this.logger.error(
        'A scan could not be queued; the retry job will queue it',
        {
          attachmentId,
          error: String(error),
        },
      );
    }
  }
}

/** What attachments tell people (texts: `i18n/<locale>/notifications.json`, under `attachment`). */
export const ATTACHMENT_NOTIFICATIONS = defineNotifications([
  {
    // To the uploader: their file was flagged as malware and removed.
    type: 'attachment.rejected',
    channels: { email: 'immediate', webhook: true },
    data: z.object({
      name: z.string(),
      subject: z.string(),
      signature: z.string(),
    }),
  },
]);
