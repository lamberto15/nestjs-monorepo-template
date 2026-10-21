import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk, StorageFileNotFoundError } from '@nestjs/storage';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { Counter } from 'prom-client';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  ImageProcessor,
  ImageRejectedError,
  type ProcessedImage,
} from '../images/image-processor.js';
import {
  RENDITION_NAMES,
  type StoredRenditions,
} from '../images/renditions.js';
import { ATTACHMENT_IMAGES_JOB } from '../platform.jobs.js';
import { tenantFileKey } from '../storage/storage.config.js';
import {
  type AttachmentImagesJob,
  AttachmentImagesQueue,
} from './attachment-images.queue.js';
import { AttachmentsService } from './attachments.service.js';
import { type Attachment, attachments } from './attachments.tables.js';

/** How an image's processing ended, as `attachment_images_processed_total{result}` counts it. */
export type ImageOutcome = 'ready' | 'failed' | 'error';

/**
 * How long an image may stay pending, once it may be served, before
 * `retryPending()` queues it again; the retry job's period too
 * (AttachmentImagesRetryJob, every five minutes, which also names the jobs it
 * queues: one per image per period).
 */
export const RETRY_MS = 5 * 60 * 1000;

/** Rows per round. */
const BATCH = 1000;

/**
 * The renditions and the metadata stripping of uploaded images
 * (IMAGE_PROCESSING, docs/attachments.md, "Image renditions"). An upload of a
 * JPEG, PNG, WebP or GIF is stored `renditionStatus: 'pending'`; once it may
 * be served (the malware scan found it clean, or scanning is off) a queue job
 * on a worker reads it, hands the bytes to the ImageProcessor, writes the
 * results next to the original and records them on the row, with an audit
 * entry (`attachment.processed`, by `system:attachment-images`), in one
 * transaction. When the original carried metadata it is replaced by a
 * stripped copy at a new key, the old file going after the commit. A file the
 * processor refuses (more than IMAGE_MAX_PIXELS, damaged, over the time limit,
 * a format it does not take) ends `failed` with the original untouched.
 */
@Injectable()
export class AttachmentImagesService {
  private readonly logger = new Logger('AttachmentImages');

  /** `attachment_images_processed_total{result}`: ready, failed (refused, as uploaded), or error (a disk or database failure; tried again). */
  private readonly processed: Counter<'result'>;

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly disk: StorageDisk,
    private readonly processor: ImageProcessor,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly queue: AttachmentImagesQueue,
    metrics: MetricsService,
  ) {
    this.processed = new Counter({
      name: 'attachment_images_processed_total',
      help: 'Uploaded images processed, by result (ready, failed, error).',
      labelNames: ['result'] as const,
      registers: [metrics.registry],
    });
  }

  /**
   * Processes one attachment (the worker, in the job's tenant). Nothing to do
   * for one that is gone, not pending, or not yet clean. Throws when the disk
   * or the database fails, so the queue tries again; a file the processor
   * refuses is `failed`, not retried.
   */
  async process(job: AttachmentImagesJob): Promise<ImageOutcome | 'skipped'> {
    // Switched off after the upload: retryPending() releases what is pending.
    if (!this.queue.enabled) {
      return 'skipped';
    }
    return this.system.run(
      ATTACHMENT_IMAGES_JOB,
      async (system) => {
        const [row] = await this.db
          .select()
          .from(attachments)
          .where(eq(attachments.id, job.attachmentId));
        // Never before the scan says clean (the scan queues this job then).
        if (
          !row ||
          row.renditionStatus !== 'pending' ||
          row.scanStatus !== 'clean'
        ) {
          return 'skipped';
        }

        let image: ProcessedImage;
        try {
          if (row.size > this.processor.maxBytes) {
            throw new ImageRejectedError(
              'size',
              `The image is ${row.size} bytes; at most ${this.processor.maxBytes} are processed.`,
            );
          }
          image = await this.processor.process(
            await this.disk.getBuffer(row.key),
          );
        } catch (error) {
          if (error instanceof ImageRejectedError) {
            return this.fail(row, error.reason, error.message, system);
          }
          if (error instanceof StorageFileNotFoundError) {
            return this.fail(
              row,
              'missing',
              'The file is not on the disk.',
              system,
            );
          }
          this.processed.inc({ result: 'error' });
          throw error;
        }

        const stored = await this.store(row, image, system);
        if (stored === 'skipped') {
          return 'skipped';
        }
        this.processed.inc({ result: 'ready' });
        this.attachments.changed(system, stored, stored.id, 'processed');
        return 'ready';
      },
      { transaction: false, tenantId: job.tenantId },
    );
  }

  /**
   * What the queue's own retries and the best-effort enqueue don't cover, for
   * the current tenant (AttachmentImagesRetryJob, every five minutes, in each
   * tenant's scope). Returns how many images it handled.
   * - Processing on: queues again the images that became processable more
   *   than `RETRY_MS` ago and are still pending (a lost job, retries spent
   *   while the disk was away).
   * - Processing off (IMAGE_PROCESSING switched back to `off` while images
   *   were pending): nothing will process them, and they would show as
   *   pending for good. They are released: no state, as the images stored
   *   while processing was off.
   */
  async retryPending(now = new Date()): Promise<number> {
    return this.system.run(
      ATTACHMENT_IMAGES_JOB,
      async () => {
        if (!this.queue.enabled) {
          return this.release();
        }
        const stale = await this.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            and(
              eq(attachments.renditionStatus, 'pending'),
              // A scan still running queues the job itself when it ends.
              eq(attachments.scanStatus, 'clean'),
              lt(attachments.updatedAt, new Date(now.getTime() - RETRY_MS)),
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

  /** Processing is off: the pending images lose their state (a round of `BATCH` at a time). */
  private async release() {
    let released = 0;
    for (;;) {
      const rows = await this.db
        .update(attachments)
        .set({ renditionStatus: null })
        .where(
          inArray(
            attachments.id,
            this.db
              .select({ id: attachments.id })
              .from(attachments)
              .where(eq(attachments.renditionStatus, 'pending'))
              .orderBy(asc(attachments.updatedAt))
              .limit(BATCH),
          ),
        )
        .returning({ id: attachments.id });
      released += rows.length;
      if (rows.length < BATCH) {
        return released;
      }
    }
  }

  /**
   * Writes the processed files and records them on the row, with the audit
   * entry, in one transaction. The files go to the disk first, under new
   * keys: the stripped original under a key of its own (the row's key changes
   * with the commit, so a download in between gets the old file whole, and
   * a failure leaves the original where it was). The row is changed only if
   * it is still pending with the key that was read; else (removed, or
   * processed by another job) the files are deleted again.
   */
  private async store(
    row: Attachment,
    image: ProcessedImage,
    system: Parameters<AttachmentsService['changed']>[0],
  ): Promise<Attachment | 'skipped'> {
    const tenantId = requireTenantId();
    const written: string[] = [];
    let updated: Attachment | undefined;
    try {
      let key = row.key;
      let size = row.size;
      if (image.stripped) {
        key = tenantFileKey(
          tenantId,
          `attachments/${randomUUID()}${posix.extname(row.key)}`,
        );
        await this.disk.put(key, image.stripped.data, {
          contentType: row.contentType,
        });
        written.push(key);
        size = image.stripped.data.length;
      }
      // Next to the original: `<id>.jpg` has `<id>.thumb.webp`.
      const stem = key.slice(0, key.length - posix.extname(key).length);
      const renditions: StoredRenditions = {};
      for (const name of RENDITION_NAMES) {
        const rendition = image.renditions[name];
        const renditionKey = `${stem}.${name}.webp`;
        await this.disk.put(renditionKey, rendition.data, {
          contentType: rendition.contentType,
        });
        written.push(renditionKey);
        renditions[name] = {
          key: renditionKey,
          size: rendition.data.length,
          width: rendition.width,
          height: rendition.height,
          contentType: rendition.contentType,
        };
      }

      updated = await inTransaction(this.txHost, async (tx) => {
        const [done] = await tx
          .update(attachments)
          .set({ key, size, renditions, renditionStatus: 'ready' })
          .where(
            and(
              eq(attachments.id, row.id),
              eq(attachments.renditionStatus, 'pending'),
              eq(attachments.key, row.key),
            ),
          )
          .returning();
        if (!done) {
          return undefined; // removed or processed meanwhile: nothing to audit
        }
        await this.audit.record(
          system,
          {
            action: 'attachment.processed',
            targetType: 'attachment',
            targetId: row.id,
            details: {
              subject: row.subject,
              recordId: row.recordId,
              name: row.name,
              renditions: Object.keys(renditions),
              // What the original carried and no longer does; empty when it
              // had none (it is as uploaded) or stripping is off.
              stripped: image.stripped?.removed ?? [],
              ...(image.stripped && { size: { from: row.size, to: size } }),
            },
          },
          tx,
        );
        return done;
      });
    } catch (error) {
      await this.dispose(written);
      this.processed.inc({ result: 'error' });
      throw error;
    }
    if (!updated) {
      await this.dispose(written);
      return 'skipped';
    }
    // After the commit, as remove() does: a failed delete leaves a file
    // nothing points at, never a row without its file.
    if (updated.key !== row.key) {
      await this.dispose([row.key]);
    }
    return updated;
  }

  /** The image stays as uploaded: `failed`, so that nothing queues it again. */
  private async fail(
    row: Attachment,
    reason: string,
    message: string,
    system: Parameters<AttachmentsService['changed']>[0],
  ): Promise<'failed'> {
    const [done] = await this.db
      .update(attachments)
      .set({ renditionStatus: 'failed' })
      .where(
        and(
          eq(attachments.id, row.id),
          eq(attachments.renditionStatus, 'pending'),
        ),
      )
      .returning({ id: attachments.id });
    this.processed.inc({ result: 'failed' });
    this.logger.warn('An image could not be processed; it stays as uploaded', {
      attachment: row.id,
      reason,
      error: message,
    });
    if (done) {
      this.attachments.changed(system, row, row.id, 'processed');
    }
    return 'failed';
  }

  /** Deletes files nothing points at; a failure leaves an orphan, never a failed job. */
  private async dispose(keys: string[]) {
    if (keys.length === 0) return;
    await this.disk.delete(keys).catch((error: unknown) =>
      this.logger.warn('Image files were not deleted', {
        keys,
        error: String(error),
      }),
    );
  }
}
