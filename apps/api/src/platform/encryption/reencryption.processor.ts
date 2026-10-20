import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job, UnrecoverableError } from 'bullmq';
import { encryptedColumnNamed } from '../../core/encryption/encrypted-columns.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { REENCRYPTION_JOB } from '../platform.jobs.js';
import {
  REENCRYPTION,
  type ReencryptionJob,
  ReencryptionService,
} from './reencryption.service.js';

/**
 * Runs one batch of the re-encryption (ReencryptionService.batch()) on the
 * workers, in the job's tenant (none for a global table), as
 * `system:reencryption`, then queues the next batch when there is one. One
 * at a time per worker: it is background work that may take its time.
 */
@Processor(REENCRYPTION, { concurrency: 1 })
export class ReencryptionProcessor extends WorkerHost {
  private readonly logger = new Logger('Reencryption');

  constructor(
    private readonly reencryption: ReencryptionService,
    private readonly system: SystemContext,
  ) {
    super();
  }

  async process(job: Job<ReencryptionJob>) {
    const { tenantId, column, after } = job.data;
    if (tenantId === undefined) {
      throw new UnrecoverableError(
        'A re-encryption job carries no tenantId (docs/tenancy.md).',
      );
    }
    const entry = encryptedColumnNamed(column);
    if (!entry) {
      // A column no longer declared: nothing to do, and retrying won't change that.
      this.logger.warn('Re-encryption of a column no longer declared', {
        column,
      });
      return { rewritten: 0, skipped: 0, failed: 0 };
    }
    const result = await this.system.run(
      REENCRYPTION_JOB,
      () => this.reencryption.batch(entry, after),
      { tenantId: entry.tenantScoped ? tenantId : null, transaction: false },
    );
    if (result.next !== undefined) {
      await this.reencryption.queueNext(job.data, result.next);
    }
    return result;
  }
}
