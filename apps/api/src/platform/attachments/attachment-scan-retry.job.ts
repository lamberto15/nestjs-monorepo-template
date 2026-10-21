import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { ATTACHMENT_SCAN_JOB } from '../platform.jobs.js';
import { AttachmentScanService } from './attachment-scan.service.js';

/**
 * Gets the uploads stuck `pending` scanned (or released) again, every five
 * minutes (`RETRY_MS`) on one instance, as the system principal
 * (`system:attachment-scan`), one tenant at a time (docs/tenancy.md:
 * `Tenancy.forEachTenant()`; deactivated tenants too, so nothing stays
 * pending for good). With scanning on it queues the scans of files pending
 * for more than five minutes: the queue's own retries last about 75 s, so a
 * scanner restarting or a lost job costs minutes, not the night. With
 * scanning off it releases the files still pending, which nothing will scan
 * (`AttachmentScanService.retryPending()`). `run(now)` lets a test choose
 * the moment; it returns how many files it handled.
 */
@Injectable()
export class AttachmentScanRetryJob {
  constructor(
    private readonly scans: AttachmentScanService,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('*/5 * * * *', {
    name: 'attachment-scan-retry',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:attachment-scan-retry' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const handled = await this.tenancy.forEachTenant(
      ATTACHMENT_SCAN_JOB.key,
      () => this.scans.retryPending(now),
      { includeInactive: true },
    );
    return [...handled.values()].reduce((sum, count) => sum + count, 0);
  }
}
