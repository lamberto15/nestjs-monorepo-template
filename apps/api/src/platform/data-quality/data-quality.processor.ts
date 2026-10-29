import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { inTenantOf, TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import {
  DATA_QUALITY,
  type DataQualityJob,
  DataQualityService,
} from './data-quality.service.js';

/**
 * Runs a data-quality scan's batches on the workers, in the tenant that
 * started it (TenantWorkerHost), one batch per job: each queues the next
 * until every subject is checked. A batch only reads records and writes
 * findings, so a retried one does no harm.
 */
@Processor(DATA_QUALITY, { concurrency: 1 })
export class DataQualityProcessor extends TenantWorkerHost<DataQualityJob> {
  private readonly logger = new Logger('DataQuality');

  constructor(private readonly quality: DataQualityService) {
    super();
  }

  async handle(job: Job<DataQualityJob>) {
    const next = await this.quality.batch(job.data);
    if (next) {
      await this.quality.queueNext(next);
    }
  }

  /** A batch that failed its last attempt: the scan failed (a new one may start). */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<DataQualityJob> | undefined, error: Error) {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }
    await inTenantOf(job.data, () => this.quality.fail(job.data.scanId)).catch(
      (failure: unknown) =>
        this.logger.error('A failed scan could not be recorded', {
          scan: job.data.scanId,
          error: String(failure),
        }),
    );
    this.logger.warn('Data-quality scan failed', {
      scan: job.data.scanId,
      error: error.message,
    });
  }
}
