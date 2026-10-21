import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import {
  ATTACHMENT_SCAN,
  type AttachmentScanJob,
} from './attachment-scan.queue.js';
import { AttachmentScanService } from './attachment-scan.service.js';

/**
 * Scans the uploads queued for it, on the workers (APP_ROLE worker or all),
 * in the upload's tenant (TenantWorkerHost). A failed scan (clamd away) is
 * tried again with backoff; after the last attempt the attachment stays
 * `pending` and the nightly sweep queues it once more.
 */
@Processor(ATTACHMENT_SCAN, { concurrency: 4 })
export class AttachmentScanProcessor extends TenantWorkerHost<AttachmentScanJob> {
  private readonly logger = new Logger('AttachmentScan');

  constructor(private readonly scans: AttachmentScanService) {
    super();
  }

  async handle(job: Job<AttachmentScanJob>) {
    const outcome = await this.scans.scan(job.data);
    this.logger.log('Upload scanned', {
      attachment: job.data.attachmentId,
      outcome,
    });
    return outcome;
  }
}
