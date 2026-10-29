import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import {
  ATTACHMENT_TEXT,
  type AttachmentTextJob,
} from './attachment-text.queue.js';
import { AttachmentTextService } from './attachment-text.service.js';

/**
 * Extracts the text of the attachments queued for it, on the workers
 * (APP_ROLE worker or all), in the upload's tenant (TenantWorkerHost). One
 * file at a time: each extraction is a thread with its own heap limit
 * (TextExtractor), which the worker's memory limit has to hold
 * (docs/deployment.md, "Resource limits"). A file the extractor refuses ends
 * `failed` without a retry; a disk or database error is tried again with
 * backoff, and past the last attempt AttachmentTextRetryJob queues it again.
 */
@Processor(ATTACHMENT_TEXT, { concurrency: 1 })
export class AttachmentTextProcessor extends TenantWorkerHost<AttachmentTextJob> {
  private readonly logger = new Logger('AttachmentText');

  constructor(private readonly texts: AttachmentTextService) {
    super();
  }

  async handle(job: Job<AttachmentTextJob>) {
    const outcome = await this.texts.process(job.data);
    this.logger.log('Attachment text extracted', {
      attachment: job.data.attachmentId,
      outcome,
    });
    return outcome;
  }
}
