import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import { isProcessable } from '../images/renditions.js';
import type { PlatformEnv } from '../platform.env.js';

/** The queue of uploaded images to process (thumbnails, previews, metadata stripping). */
export const ATTACHMENT_IMAGES = 'attachment-images';

/** What a queued job carries: the attachment, and its tenant (docs/tenancy.md). */
export interface AttachmentImagesJob extends TenantEnvelope {
  readonly tenantId: string;
  attachmentId: string;
}

/**
 * Queues the processing of uploaded images (IMAGE_PROCESSING). Apart from
 * AttachmentImagesService, which reads the attachments, so that the
 * attachments service and the malware scan can queue a job without depending
 * on it. A job is queued once the file may be served (`scanStatus`
 * `clean`): when the upload is stored with the scanner off, or when the
 * scan finds it clean.
 */
@Injectable()
export class AttachmentImagesQueue {
  private readonly logger = new Logger('AttachmentImages');

  constructor(
    @InjectQueue(ATTACHMENT_IMAGES)
    private readonly queue: Queue<AttachmentImagesJob>,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  /** Whether uploaded images are processed: IMAGE_PROCESSING is not `off`. */
  get enabled() {
    return this.config.get('IMAGE_PROCESSING', { infer: true });
  }

  /** Whether an upload of this (detected) content type gets processed. */
  wants(contentType: string) {
    return this.enabled && isProcessable(contentType);
  }

  /**
   * Queues the processing of an attachment (in the current tenant's scope),
   * after the transaction that made it processable committed. `again`: a name
   * for the job when AttachmentImagesRetryJob queues one that never finished
   * (a job id is queued once, and a finished job is kept for a while). A
   * failure is logged, not thrown: the image stays `pending` and the retry job
   * queues it again within minutes.
   */
  async enqueue(attachmentId: string, again?: string) {
    try {
      await this.queue.add('process', withTenant({ attachmentId }), {
        jobId: again ? `${attachmentId}-${again}` : attachmentId,
        // The retry job queues a pending image again every few minutes while
        // the disk or the database fails: keep the failures bounded (the
        // queues' default keeps them seven days).
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch (error) {
      this.logger.error(
        'An image could not be queued; the retry job will queue it',
        { attachmentId, error: String(error) },
      );
    }
  }
}
