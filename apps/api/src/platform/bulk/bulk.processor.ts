import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Job } from 'bullmq';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { stillActive } from '../queues/still-active.js';
import { Realtime } from '../realtime/realtime.service.js';
import { BulkRegistry } from './bulk.registry.js';
import { BULK, BulkService, PRINCIPAL_GONE } from './bulk.service.js';
import {
  type BulkJob,
  type BulkResult,
  MAX_BULK_RESULTS,
} from './bulk.types.js';

/**
 * Runs the bulk runs too large for a request, on the workers (APP_ROLE
 * worker or all). The principal is checked again when the job starts: a
 * user deactivated in the meantime gets nothing done.
 */
// maxStalledCount 0: a run whose worker was lost (a redeploy mid-way) fails
// instead of starting over; items done stay done (the audit says which).
@Processor(BULK, { concurrency: 2, maxStalledCount: 0 })
export class BulkProcessor extends WorkerHost {
  private readonly logger = new Logger('Bulk');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly bulk: BulkService,
    private readonly registry: BulkRegistry,
    private readonly realtime: Realtime,
    private readonly users: UsersRepository,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {
    super();
  }

  async process(job: Job<BulkJob>): Promise<BulkResult> {
    const principal = await stillActive(
      job.data.principal,
      this.users,
      this.db,
    );
    if (!principal) {
      throw new Error(PRINCIPAL_GONE);
    }
    const operation = this.registry.get(job.data.name);
    if (!operation) {
      throw new Error(`No bulk operation named "${job.data.name}".`);
    }
    // Parsed here, not at enqueue: the job is JSON. The request checked them.
    const { selection, input } = this.bulk.parse(operation, job.data);
    const result = await this.bulk.execute(
      principal,
      operation,
      job.data.action,
      selection,
      input,
      job.data.ip,
      {
        cap: MAX_BULK_RESULTS,
        progress: (tally) =>
          job.updateProgress({
            processed: tally.processed,
            done: tally.done,
            failed: tally.failed,
          }),
      },
    );
    await job.updateProgress({
      processed: result.done + result.failed,
      done: result.done,
      failed: result.failed,
    });
    await this.bulk.finished(principal, job.data, job.id!, result);
    this.realtime.toPrincipal(principal, 'bulk.finished', {
      id: job.id,
      name: job.data.name,
      action: job.data.action,
      done: result.done,
      failed: result.failed,
    });
    this.logger.log('Bulk run done', {
      id: job.id,
      name: job.data.name,
      action: job.data.action,
      done: result.done,
      failed: result.failed,
    });
    return result;
  }
}
