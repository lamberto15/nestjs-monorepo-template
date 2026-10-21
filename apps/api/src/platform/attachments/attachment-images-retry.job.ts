import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { ATTACHMENT_IMAGES_JOB } from '../platform.jobs.js';
import { AttachmentImagesService } from './attachment-images.service.js';

/**
 * Gets the uploaded images stuck `pending` processed again, every five
 * minutes on one instance, as the system principal
 * (`system:attachment-images`), one tenant at a time (docs/tenancy.md:
 * `Tenancy.forEachTenant()`; deactivated tenants too). With processing on it
 * queues the images that were made processable (scanned clean, or uploaded
 * with the scanner off) more than five minutes ago and are still pending: a
 * job lost with a Redis that restarted, or retries spent while the disk was
 * away. With processing off it releases them (nothing will process them), so
 * no image stays `pending` for good (`AttachmentImagesService.retryPending()`).
 * `run(now)` lets a test choose the moment; it returns how many images it
 * handled.
 */
@Injectable()
export class AttachmentImagesRetryJob {
  constructor(
    private readonly images: AttachmentImagesService,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('*/5 * * * *', {
    name: 'attachment-images-retry',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:attachment-images-retry' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const handled = await this.tenancy.forEachTenant(
      ATTACHMENT_IMAGES_JOB.key,
      () => this.images.retryPending(now),
      { includeInactive: true },
    );
    return [...handled.values()].reduce((sum, count) => sum + count, 0);
  }
}
