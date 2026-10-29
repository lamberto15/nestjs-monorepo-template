import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import type { PlatformEnv } from '../platform.env.js';

/** The queue of attachments whose text to extract (the search inside files). */
export const ATTACHMENT_TEXT = 'attachment-text';

/** What a queued job carries: the attachment, and its tenant (docs/tenancy.md). */
export interface AttachmentTextJob extends TenantEnvelope {
  readonly tenantId: string;
  attachmentId: string;
}

/**
 * Queues text extractions (ATTACHMENT_TEXT_SEARCH). Apart from
 * AttachmentTextService, so that the attachments service can queue one
 * without depending on it: after an upload is stored and after its scan
 * finds it clean (`AttachmentsService.changed()`); the job itself decides
 * whether there is anything to extract.
 */
@Injectable()
export class AttachmentTextQueue {
  private readonly logger = new Logger('AttachmentText');

  constructor(
    @InjectQueue(ATTACHMENT_TEXT)
    private readonly queue: Queue<AttachmentTextJob>,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  /** Whether files are searched by their text: ATTACHMENT_TEXT_SEARCH is `on`. */
  get enabled() {
    return this.config.get('ATTACHMENT_TEXT_SEARCH', { infer: true });
  }

  /**
   * Queues the extraction of an attachment's text (in the current tenant's
   * scope). `name`: what makes the job id unique (an upload's, a scan's, a
   * retry period's): a job id is queued once, and a finished job is kept
   * for a while. A failure is logged, not thrown: AttachmentTextRetryJob
   * queues what has no text within minutes.
   */
  async enqueue(attachmentId: string, name: string) {
    if (!this.enabled) return;
    try {
      await this.queue.add('extract', withTenant({ attachmentId }), {
        jobId: `${attachmentId}-${name}`,
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch (error) {
      this.logger.error(
        'A text extraction could not be queued; the retry job will queue it',
        { attachmentId, error: String(error) },
      );
    }
  }
}
