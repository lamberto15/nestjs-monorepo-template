import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { inTenantOf, TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { STALLED_REASON } from '../data-transfer/data-transfer.processor.js';
import { stillActive } from '../queues/still-active.js';
import { AI, AI_ERRORS, type AiJob, AiService } from './ai.service.js';

/**
 * Does the AI runs asked for, on the workers, in the tenant it was asked
 * for in, as the principal who asked (checked again first). Two at once per
 * worker. `lockDuration` is 3 minutes, longer than the longest call
 * (AI_TIMEOUT_MS is at most 2 minutes): otherwise BullMQ would see the job
 * as stalled while the provider still works, retry it, and the call would
 * be paid for twice.
 */
@Processor(AI, { concurrency: 2, lockDuration: 180_000 })
export class AiProcessor extends TenantWorkerHost<AiJob> {
  private readonly logger = new Logger('Ai');

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly ai: AiService,
    private readonly users: UsersRepository,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {
    super();
  }

  async handle(job: Job<AiJob>) {
    const principal = await stillActive(
      job.data.principal,
      this.users,
      this.db,
    );
    return this.ai.run(job.data, principal);
  }

  /** Every failure for good fails the run, whatever got it there; a retry leaves it open. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AiJob> | undefined, error: Error) {
    if (!job) return;
    const final =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      error.message === STALLED_REASON ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!final) return;
    const reason = (Object.values(AI_ERRORS) as string[]).includes(
      error.message,
    )
      ? error.message
      : AI_ERRORS.unavailable;
    await inTenantOf(job.data, () => this.ai.fail(job.data, reason)).catch(
      (failure: unknown) =>
        this.logger.error('A failed AI run could not be marked failed', {
          id: job.data.id,
          error: String(failure),
        }),
    );
  }
}
