import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import {
  ATTACHMENT_IMAGES,
  type AttachmentImagesJob,
} from './attachment-images.queue.js';
import { AttachmentImagesService } from './attachment-images.service.js';

/**
 * Processes the uploaded images queued for it, on the workers (APP_ROLE
 * worker or all), in the upload's tenant (TenantWorkerHost). One image at a
 * time: libvips works outside the V8 heap (about 4 bytes per pixel at its
 * peak), which the worker's memory limit has to hold
 * (docs/deployment.md, "Resource limits"); more throughput is more worker
 * replicas. A file that cannot be processed ends the job as `failed`
 * without a retry (the same bytes fail again); a disk or database error is
 * tried again with backoff, and past the last attempt the image stays
 * `pending` for AttachmentImagesRetryJob.
 */
@Processor(ATTACHMENT_IMAGES, { concurrency: 1 })
export class AttachmentImagesProcessor extends TenantWorkerHost<AttachmentImagesJob> {
  private readonly logger = new Logger('AttachmentImages');

  constructor(private readonly images: AttachmentImagesService) {
    super();
  }

  async handle(job: Job<AttachmentImagesJob>) {
    const outcome = await this.images.process(job.data);
    this.logger.log('Image processed', {
      attachment: job.data.attachmentId,
      outcome,
    });
    return outcome;
  }
}
