import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk, StorageFileNotFoundError } from '@nestjs/storage';
import { and, asc, eq, inArray, isNull, lt, notExists } from 'drizzle-orm';
import { Counter } from 'prom-client';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { ATTACHMENT_TEXT_JOB } from '../platform.jobs.js';
import {
  type AttachmentTextJob,
  AttachmentTextQueue,
} from './attachment-text.queue.js';
import {
  type AttachmentTextStatus,
  attachmentTexts,
} from './attachment-text.tables.js';
import { type Attachment, attachments } from './attachments.tables.js';
import {
  EXTRACTABLE_TYPES,
  isExtractable,
  TextExtractor,
  TextRejectedError,
} from './text-extractor.js';

/**
 * How long a clean, extractable file may go without its text before
 * `retryPending()` queues it again; the retry job's period too.
 */
export const RETRY_MS = 5 * 60 * 1000;

/** Rows per round. */
const BATCH = 1000;

/**
 * The text of uploaded files, for the search inside attachments
 * (ATTACHMENT_TEXT_SEARCH, docs/attachments.md, "Search inside files"). A
 * queue job on a worker reads a clean upload of an extractable type, hands
 * the bytes to the sandboxed TextExtractor and stores the text with the key
 * of the file it came from (`attachment_texts`). A file the extractor
 * refuses is stored `failed`, without text, and not tried again. Generated
 * files (an issued PDF, `fields` set) are left out: their text is the
 * record's fields, which the record's own search matches under field-level
 * permissions.
 */
@Injectable()
export class AttachmentTextService {
  private readonly logger = new Logger('AttachmentText');

  /** `attachment_texts_extracted_total{result}`: ready, failed (refused), or error (a disk or database failure; tried again). */
  private readonly extracted: Counter<'result'>;

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly disk: StorageDisk,
    private readonly extractor: TextExtractor,
    private readonly system: SystemContext,
    private readonly queue: AttachmentTextQueue,
    metrics: MetricsService,
  ) {
    this.extracted = new Counter({
      name: 'attachment_texts_extracted_total',
      help: 'Attachment texts extracted for search, by result (ready, failed, error).',
      labelNames: ['result'] as const,
      registers: [metrics.registry],
    });
  }

  /**
   * Extracts one attachment's text (the worker, in the job's tenant).
   * Nothing to do for one that is gone, not clean yet, generated, of another
   * type, or whose current file already has its text. Throws when the disk
   * or the database fails, so the queue tries again.
   */
  async process(
    job: AttachmentTextJob,
  ): Promise<AttachmentTextStatus | 'skipped'> {
    if (!this.queue.enabled) {
      return 'skipped';
    }
    return this.system.run(
      ATTACHMENT_TEXT_JOB,
      async () => {
        const [row] = await this.db
          .select()
          .from(attachments)
          .where(eq(attachments.id, job.attachmentId));
        if (
          !row ||
          row.scanStatus !== 'clean' ||
          row.fields !== null ||
          !isExtractable(row.contentType)
        ) {
          return 'skipped';
        }
        const [done] = await this.db
          .select({ id: attachmentTexts.id })
          .from(attachmentTexts)
          .where(
            and(
              eq(attachmentTexts.attachmentId, row.id),
              eq(attachmentTexts.key, row.key),
            ),
          );
        if (done) {
          return 'skipped';
        }

        let status: AttachmentTextStatus = 'ready';
        let text = '';
        try {
          if (row.size > this.extractor.maxBytes) {
            throw new TextRejectedError(
              'size',
              `The file is ${row.size} bytes; at most ${this.extractor.maxBytes} are read.`,
            );
          }
          text = await this.extractor.extract(
            await this.disk.getBuffer(row.key),
            row.contentType,
          );
        } catch (error) {
          if (
            !(error instanceof TextRejectedError) &&
            !(error instanceof StorageFileNotFoundError)
          ) {
            this.extracted.inc({ result: 'error' });
            throw error;
          }
          status = 'failed';
          this.logger.warn('A file is not searchable: its text was refused', {
            attachment: row.id,
            reason:
              error instanceof TextRejectedError ? error.reason : 'missing',
            error: error.message,
          });
        }
        if (!(await this.store(row, status, text))) {
          return 'skipped';
        }
        this.extracted.inc({ result: status });
        return status;
      },
      { transaction: false, tenantId: job.tenantId },
    );
  }

  /**
   * What the best-effort enqueue and the queue's retries don't cover, for
   * the current tenant (AttachmentTextRetryJob, every five minutes): the
   * clean, extractable uploads changed more than `RETRY_MS` ago that have no
   * text for their current file. A lost job, retries spent while the disk
   * was away, a replaced file, and the files stored before
   * ATTACHMENT_TEXT_SEARCH was switched on (`BATCH` a round). Returns how
   * many it queued.
   */
  async retryPending(now = new Date()): Promise<number> {
    if (!this.queue.enabled) {
      return 0;
    }
    return this.system.run(
      ATTACHMENT_TEXT_JOB,
      async () => {
        const stale = await this.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            and(
              eq(attachments.scanStatus, 'clean'),
              isNull(attachments.fields),
              inArray(attachments.contentType, [...EXTRACTABLE_TYPES]),
              lt(attachments.updatedAt, new Date(now.getTime() - RETRY_MS)),
              notExists(
                this.db
                  .select({ id: attachmentTexts.id })
                  .from(attachmentTexts)
                  .where(
                    and(
                      eq(attachmentTexts.attachmentId, attachments.id),
                      eq(attachmentTexts.key, attachments.key),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(attachments.updatedAt))
          .limit(BATCH);
        const period = String(Math.floor(now.getTime() / RETRY_MS));
        for (const { id } of stale) {
          await this.queue.enqueue(id, period);
        }
        return stale.length;
      },
      { transaction: false },
    );
  }

  /**
   * Stores the text of the file at `row.key`, replacing what an earlier file
   * of the attachment had. Only while the attachment still has that file
   * (locked against its removal until the commit); else nothing (false).
   */
  private store(row: Attachment, status: AttachmentTextStatus, text: string) {
    return inTransaction(this.txHost, async (tx) => {
      const [current] = await tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(and(eq(attachments.id, row.id), eq(attachments.key, row.key)))
        .for('share');
      if (!current) {
        return false;
      }
      await tx
        .insert(attachmentTexts)
        .values({
          tenantId: requireTenantId(),
          attachmentId: row.id,
          key: row.key,
          status,
          text,
        })
        .onConflictDoUpdate({
          target: attachmentTexts.attachmentId,
          set: { key: row.key, status, text, updatedAt: new Date() },
        });
      return true;
    });
  }
}
