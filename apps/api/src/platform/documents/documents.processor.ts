import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { STALLED_REASON } from '../data-transfer/data-transfer.processor.js';
import { stillActive } from '../queues/still-active.js';
import {
  DOCUMENT_ERRORS,
  DOCUMENTS,
  type DocumentJob,
  DocumentsService,
} from './documents.service.js';

/**
 * Renders the documents asked for, on the workers (APP_ROLE worker or all),
 * as the principal who asked, checked again first: a user deactivated in
 * the meantime gets nothing issued. Two at once per worker: each is a
 * Chromium page in Gotenberg, whose own limits are the real bound.
 */
@Processor(DOCUMENTS, { concurrency: 2 })
export class DocumentsProcessor extends WorkerHost {
  private readonly logger = new Logger('Documents');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly documents: DocumentsService,
    private readonly users: UsersRepository,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {
    super();
  }

  async process(job: Job<DocumentJob>) {
    const principal = await stillActive(
      job.data.principal,
      this.users,
      this.db,
    );
    return this.documents.issue(job.data, principal, {
      final: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });
  }

  /**
   * Every failure for good fails the document, whatever got it there:
   * `issue()` has done so with the precise reason (then this is a no-op:
   * `fail()` changes only a queued or rendering document), but a render
   * whose worker died mid-way stalls, and past the limit the next worker
   * fails it without calling `process()`; an error before `issue()` (the
   * principal's check) never reached it. No document stays queued or
   * rendering for ever.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<DocumentJob> | undefined, error: Error) {
    if (!job) {
      return;
    }
    const final =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      error.message === STALLED_REASON ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!final) {
      return;
    }
    if (error.message === STALLED_REASON) {
      this.logger.warn('A document render stalled and was failed', {
        id: job.data.id,
      });
    }
    await this.documents
      .fail(job.data, DOCUMENT_ERRORS.unavailable)
      .catch((failure: unknown) =>
        this.logger.error('A failed document could not be marked failed', {
          id: job.data.id,
          error: String(failure),
        }),
      );
  }
}
