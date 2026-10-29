import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { ATTACHMENT_TEXT_JOB } from '../platform.jobs.js';
import { AttachmentTextService } from './attachment-text.service.js';

/**
 * Queues the text extraction of the clean, extractable uploads that have no
 * text for their current file, every five minutes on one instance, one
 * tenant at a time (`Tenancy.forEachTenant()`): lost jobs, replaced files,
 * and what was stored before ATTACHMENT_TEXT_SEARCH was switched on
 * (`AttachmentTextService.retryPending()`). `run(now)` lets a test choose
 * the moment; it returns how many it queued.
 */
@Injectable()
export class AttachmentTextRetryJob {
  constructor(
    private readonly texts: AttachmentTextService,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('*/5 * * * *', {
    name: 'attachment-text-retry',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:attachment-text-retry' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const handled = await this.tenancy.forEachTenant(
      ATTACHMENT_TEXT_JOB.key,
      () => this.texts.retryPending(now),
    );
    return [...handled.values()].reduce((sum, count) => sum + count, 0);
  }
}
