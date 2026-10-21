import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { STALLED_REASON } from '../data-transfer/data-transfer.processor.js';
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
 * `pending` for AttachmentImagesRetryJob. An image the worker dies on (twice:
 * `onFailed`) ends `failed`.
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

  /**
   * A worker that dies while converting (killed at its memory limit, a
   * crash in the library) leaves its job stalled: BullMQ runs it once more
   * (`maxStalledCount`, 1), and when that run dies too the next worker fails
   * the job without calling `process()`. Then the image is `failed`, as
   * uploaded, so that the retry job does not queue it, and the worker die on
   * it, every five minutes for good. Any other failure (a disk or database
   * error past the last attempt) leaves it pending for the retry job.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AttachmentImagesJob> | undefined, error: Error) {
    if (!job || error.message !== STALLED_REASON) {
      return;
    }
    this.logger.warn('An image stalled its worker twice and was failed', {
      attachment: job.data.attachmentId,
    });
    await this.images.stalled(job.data).catch((failure: unknown) =>
      this.logger.error('A stalled image could not be marked failed', {
        attachment: job.data.attachmentId,
        error: String(failure),
      }),
    );
  }
}
