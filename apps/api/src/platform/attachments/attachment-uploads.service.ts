import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk, StorageFileNotFoundError } from '@nestjs/storage';
import { and, count, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import type { PlatformEnv } from '../platform.env.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import { attachmentLimits, presignedUploads } from './attachment-limits.js';
import { directUploadType, isAllowedType } from './attachment-types.js';
import {
  checkUploadedObject,
  type UploadVerdict,
  uploadIncomplete,
} from './attachment-upload-check.js';
import type {
  AttachmentView,
  PresignedUploadView,
  UploadSessionView,
} from './attachment.schemas.js';
import { attachmentKey, AttachmentsService } from './attachments.service.js';
import {
  type AttachmentUpload,
  attachmentUploads,
} from './attachments.tables.js';

/** How long the signed PUT URL works. */
export const UPLOAD_LINK_TTL = '10m';

/**
 * How long after its URL expired an upload may still be completed, and how
 * long the sweep leaves it alone: a PUT that began just before the expiry
 * may still be arriving, and the client completes when it is done.
 */
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;

/** A request completing an upload holds it this long; a request that died no longer does. */
const CLAIM_MS = 5 * 60 * 1000;

/** How long a resumable session stays open (the sweep removes it an hour later). */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The most a chunk of a resumable session may carry: a larger one is a 413. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Where the chunks of a resumable session are kept: next to its key, never a key an attachment uses. */
export const partsPrefix = (key: string) => `${key}.parts/`;
const partKey = (key: string, offset: number) =>
  `${partsPrefix(key)}${String(offset).padStart(15, '0')}`;

/**
 * Every object a session or announced upload may have left: its key and, for
 * a resumable one, its parts (and chunks that never got a place). Shared with
 * the sweep.
 */
export async function uploadObjects(
  disk: StorageDisk,
  upload: { key: string; resumable: boolean },
) {
  const keys = [upload.key];
  if (upload.resumable) {
    for await (const entry of disk.listAll({
      prefix: partsPrefix(upload.key),
    })) {
      keys.push(entry.key);
    }
  }
  return keys;
}

/** The most uploads one uploader may have announced and not completed, whose URL still works: the objects they leave are not counted by the storage quota. */
export const MAX_PENDING_UPLOADS = 100;

/**
 * Uploads that go straight from the client to the object store
 * (`STORAGE_DRIVER=s3`), not through the API's memory and time limits:
 *
 * 1. `presign()` checks the right to attach files to the record and the
 *    announced size and type, picks the key itself (under the tenant's
 *    prefix: never the client's), signs a PUT URL bound to that key, size and
 *    `Content-Type` for ten minutes, and remembers it (`attachment_uploads`).
 * 2. The client PUTs the file to the URL.
 * 3. `complete()` copies the object to a key of the server's own, which no
 *    signed URL reaches (the URL works until it expires, and whoever holds it
 *    can PUT again, also after the check and the scan), verifies the copy
 *    (its size and type by HEAD, its first bytes by a ranged GET, as the
 *    upload through the API reads them), then creates the attachment from the
 *    copy through `AttachmentsService.upload()`, the same path as an upload
 *    through the API: quota, tenant, audit entry, malware scan and image
 *    renditions. A copy that fails verification is deleted, and the object it
 *    came from.
 *
 * What was PUT to the signed URL is never the attachment's file. It is
 * deleted on completion, and again, with the row, by the sweep once the URL
 * has expired, so a PUT after the completion leaves nothing behind. An object
 * that is never completed is swept with its row (AttachmentSweepJob).
 * The signing is @nestjs/storage's own (`signedUpload()`: SigV4 on an S3 disk).
 */
@Injectable()
export class AttachmentUploadsService {
  private readonly logger = new Logger(AttachmentUploadsService.name);

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly disk: StorageDisk,
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    private readonly attachments: AttachmentsService,
    private readonly quotas: TenantQuotas,
  ) {}

  /** Whether this deployment offers direct uploads (`GET /v1/features`: `presignedUploads`). */
  get enabled() {
    return presignedUploads(this.config.get('STORAGE_DRIVER', { infer: true }));
  }

  /**
   * Announces an upload and returns what the client PUTs to: 503
   * `presigned_uploads_unavailable` unless `STORAGE_DRIVER=s3`; 404 or 403
   * without the right to attach files to the record; 413 over
   * ATTACHMENT_MAX_MB; 415 for a type not allowed or not declared; 422
   * `quota_exceeded` when the tenant has no room; 429
   * `attachment_uploads_pending` past MAX_PENDING_UPLOADS uploads announced,
   * not completed, and whose URL has not expired.
   */
  async presign(
    principal: Principal,
    record: RecordRef,
    request: { name: string; size: number; contentType: string },
  ): Promise<PresignedUploadView> {
    this.assertEnabled();
    const contentType = await this.check(principal, record, request);
    // The server's key, under the tenant's prefix, the way an upload through the API gets one.
    const key = attachmentKey(principal);
    const signed = await this.disk.signedUpload(key, {
      contentType,
      contentLength: request.size,
      expiresIn: UPLOAD_LINK_TTL,
    });
    const row = await this.register(principal, record, {
      key,
      name: request.name,
      size: request.size,
      contentType,
      expiresAt: signed.expiresAt,
      resumable: false,
    });
    // Content-Length is the file's size, set by the client's HTTP client (a browser forbids setting it).
    const { 'content-length': _length, ...headers } = signed.headers;
    return {
      uploadId: row.id,
      url: signed.url,
      method: signed.method,
      headers,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /**
   * What an announced upload must satisfy before anything moves: the right
   * to attach files to the record (404, 403), the size within
   * ATTACHMENT_MAX_MB (413) and a declared type that is allowed (415).
   * Returns the type the upload is made for. The bytes are read again on
   * completion.
   */
  private async check(
    principal: Principal,
    record: RecordRef,
    request: { size: number; contentType: string },
  ) {
    await this.attachments.assertCanUpload(principal, record);
    const limits = attachmentLimits(this.config);
    if (request.size > limits.maxBytes) {
      throw new PayloadTooLargeException('File too large');
    }
    const contentType = directUploadType(request.contentType);
    if (!contentType) {
      throw new UnsupportedMediaTypeException(
        "Declare the file's type (contentType): an announced upload is made for it.",
      );
    }
    if (!isAllowedType(contentType, limits.types)) {
      throw new UnsupportedMediaTypeException(
        `File type not allowed. Allowed types: ${limits.types.join(', ')}`,
      );
    }
    return contentType;
  }

  /** Remembers an announced upload (`attachment_uploads`): the quota and the cap on pending ones are checked here. */
  private async register(
    principal: Principal,
    record: RecordRef,
    upload: {
      key: string;
      name: string;
      size: number;
      contentType: string;
      expiresAt: Date;
      resumable: boolean;
    },
  ) {
    const tenantId = requireTenantId();
    const uploadedBy = principalKey(principal);
    return inTransaction(this.txHost, async (tx) => {
      // Early, so a client does not send 25 MB to be refused on completion.
      await this.quotas.assertRoom(tx, tenantId, 'storageBytes', upload.size);
      // Only the uploads that can still be completed: an expired one (a PUT
      // that failed, a tab closed) frees its place, though the sweep deletes
      // its row only at night.
      const [pending] = await tx
        .select({ pending: count() })
        .from(attachmentUploads)
        .where(
          and(
            eq(attachmentUploads.uploadedBy, uploadedBy),
            isNull(attachmentUploads.completedAt),
            gt(attachmentUploads.expiresAt, new Date()),
          ),
        );
      if ((pending?.pending ?? 0) >= MAX_PENDING_UPLOADS) {
        throw new HttpException(
          {
            code: 'attachment_uploads_pending',
            message: `You have ${MAX_PENDING_UPLOADS} uploads announced and not completed: complete them, or wait for their links to expire.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const [inserted] = await tx
        .insert(attachmentUploads)
        .values({
          subject: record.subject,
          recordId: record.recordId,
          ...upload,
          uploadedBy,
        })
        .returning();
      return inserted!;
    });
  }

  /**
   * Opens a resumable session: same checks as `presign()` (right, size, type,
   * quota, the cap on pending uploads), on every storage driver. The client
   * then sends chunks with `append()`, asks `progress()` to resume after a
   * failure, `cancel()`s, and finally `complete()`s.
   */
  async start(
    principal: Principal,
    record: RecordRef,
    request: { name: string; size: number; contentType: string },
  ): Promise<UploadSessionView> {
    const contentType = await this.check(principal, record, request);
    const row = await this.register(principal, record, {
      key: attachmentKey(principal),
      name: request.name,
      size: request.size,
      contentType,
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS),
      resumable: true,
    });
    return sessionView(row);
  }

  /** How far a session got: 404 for one that is not the caller's, completed or removed. */
  async progress(
    principal: Principal,
    record: RecordRef,
    uploadId: string,
  ): Promise<UploadSessionView> {
    await this.attachments.assertCanUpload(principal, record);
    return sessionView(await this.session(principal, record, uploadId));
  }

  /**
   * Stores the next chunk of a session. `offset` must be what has been
   * received (409 `attachment_upload_offset_mismatch` otherwise: ask
   * `progress()` and continue from there, which also makes a retried chunk
   * safe). A chunk is at most UPLOAD_CHUNK_BYTES and never goes past the
   * announced size (413). The chunk is written to a name of its own and
   * takes its place only if the offset is still the next one, so two
   * parallel requests with one offset store one chunk.
   */
  async append(
    principal: Principal,
    record: RecordRef,
    uploadId: string,
    offset: number,
    body: Readable,
  ): Promise<UploadSessionView> {
    // Checked again: the right may have gone since the session began.
    await this.attachments.assertCanUpload(principal, record);
    const upload = await this.session(principal, record, uploadId);
    if (upload.expiresAt.getTime() < Date.now()) {
      throw new GoneException({
        code: 'attachment_upload_expired',
        message: 'This upload expired: start it again.',
      });
    }
    if (offset !== upload.received) {
      throw offsetMismatch(upload.received);
    }
    const limit = Math.min(UPLOAD_CHUNK_BYTES, upload.size - offset);
    if (limit <= 0) {
      throw new BadRequestException(
        'The whole file has been received: complete the upload.',
      );
    }
    const temporary = `${partsPrefix(upload.key)}tmp-${randomUUID()}`;
    let length = 0;
    try {
      await this.disk.put(
        temporary,
        (async function* () {
          for await (const chunk of body) {
            length += (chunk as Buffer).length;
            if (length > limit) {
              throw new PayloadTooLargeException(
                `A chunk carries at most ${limit} bytes here.`,
              );
            }
            yield chunk as Buffer;
          }
        })(),
        { contentType: 'application/octet-stream' },
      );
      if (length === 0) {
        throw new BadRequestException('The chunk is empty.');
      }
      const [advanced] = await this.db
        .update(attachmentUploads)
        .set({ received: offset + length })
        .where(
          and(
            eq(attachmentUploads.id, upload.id),
            eq(attachmentUploads.received, offset),
            isNull(attachmentUploads.completingAt),
            isNull(attachmentUploads.completedAt),
          ),
        )
        .returning();
      if (!advanced) {
        throw offsetMismatch(
          (await this.session(principal, record, uploadId)).received,
        );
      }
      await this.disk.move(temporary, partKey(upload.key, offset));
      return sessionView(advanced);
    } catch (error) {
      await this.forget(temporary);
      throw error;
    }
  }

  /** Cancels a session: its chunks and its row go; 404 for one that is not the caller's. */
  async cancel(principal: Principal, record: RecordRef, uploadId: string) {
    const upload = await this.claim(principal, record, uploadId);
    await this.disk.delete(await uploadObjects(this.disk, upload));
    await this.db
      .delete(attachmentUploads)
      .where(eq(attachmentUploads.id, upload.id));
  }

  /** The caller's own open session for this record, or a 404. */
  private async session(
    principal: Principal,
    record: RecordRef,
    uploadId: string,
  ) {
    const [row] = await this.db
      .select()
      .from(attachmentUploads)
      .where(
        and(
          eq(attachmentUploads.id, uploadId),
          eq(attachmentUploads.subject, record.subject),
          eq(attachmentUploads.recordId, record.recordId),
          eq(attachmentUploads.uploadedBy, principalKey(principal)),
          eq(attachmentUploads.resumable, true),
          isNull(attachmentUploads.completedAt),
        ),
      );
    if (!row) {
      throw new NotFoundException({
        code: 'attachment_upload_not_found',
        message: `Upload ${uploadId} not found.`,
      });
    }
    return row;
  }

  /**
   * Creates the attachment of an upload the client has PUT: copies the
   * object to a key of the server's own and verifies the copy, then
   * `AttachmentsService.upload()` stores the row, audits it and queues the
   * scan and the renditions (a later PUT to the signed URL changes none of
   * it). The upload is the caller's own
   * (`uploadId`): 404 `attachment_upload_not_found` otherwise, 409
   * `attachment_upload_in_progress` while another request completes it,
   * 409 `attachment_upload_incomplete` when nothing was PUT yet (try again),
   * 410 `attachment_upload_expired` an hour after the URL did. A file that is
   * not what was announced is deleted: 413, 415 or 400
   * `attachment_upload_mismatch`.
   */
  async complete(
    principal: Principal,
    record: RecordRef,
    uploadId: string,
    ip?: string,
  ): Promise<AttachmentView> {
    // Checked again: the right may have gone since the URL was signed.
    await this.attachments.assertCanUpload(principal, record);
    const upload = await this.claim(principal, record, uploadId);
    if (!upload.resumable && !this.enabled) {
      await this.release(upload);
      this.assertEnabled();
    }
    if (upload.expiresAt.getTime() + UPLOAD_GRACE_MS < Date.now()) {
      await this.discard(upload);
      throw new GoneException({
        code: 'attachment_upload_expired',
        message: 'This upload expired: announce it again.',
      });
    }
    // The signed URL works until it expires: whoever holds it can PUT again to
    // `upload.key`, after the check below and after the malware scan. So the
    // attachment is a copy on a key of the server's own, which no URL reaches,
    // and it is the copy that is verified: the bytes checked are the bytes kept.
    const key = attachmentKey(principal);
    let verdict: UploadVerdict;
    try {
      if (upload.resumable) {
        // Everything arrived, in order: the parts become the one object that is checked below.
        await this.assemble(upload);
      }
      await this.disk.copy(upload.key, key);
      verdict = await checkUploadedObject(
        this.disk,
        { ...upload, key },
        attachmentLimits(this.config),
      );
    } catch (error) {
      // The store could not be asked: nothing is known of the file, try again later.
      await this.forget(key);
      await this.release(upload);
      throw error instanceof StorageFileNotFoundError
        ? uploadIncomplete()
        : error;
    }
    if (!verdict.ok) {
      await this.forget(key);
      await (verdict.keep ? this.release(upload) : this.discard(upload));
      throw verdict.error;
    }
    let attachment: AttachmentView;
    try {
      attachment = await this.attachments.upload(
        principal,
        record,
        {
          key,
          originalname: upload.name,
          size: verdict.size,
          // What the bytes are, as for an upload through the API.
          contentType: verdict.contentType,
        },
        ip,
        // With the attachment, or not at all: the upload is completed when the attachment exists.
        {
          within: (tx) =>
            tx
              .update(attachmentUploads)
              .set({ completedAt: new Date() })
              .where(eq(attachmentUploads.id, upload.id)),
        },
      );
    } catch (error) {
      // upload() deleted the copy. What was PUT and the row have nothing left to wait for.
      await this.discard(upload);
      throw error;
    }
    // Not the attachment's file, and the URL may still take another PUT: the
    // row stays, so the sweep deletes the object again once the URL expired.
    await this.forget(upload.key);
    if (upload.resumable) {
      await this.disk
        .delete(await uploadObjects(this.disk, upload))
        .catch((error: unknown) =>
          this.logger.warn('The parts of an upload were not deleted', {
            upload: upload.id,
            error: String(error),
          }),
        );
    }
    return attachment;
  }

  /**
   * Writes the parts of a resumable session, in offset order, to the
   * session's key as one object of the announced type. 409
   * `attachment_upload_incomplete` (the session stays) when bytes are still
   * missing; parts that do not add up to the announced size are a 400
   * `attachment_upload_mismatch` and the session is discarded.
   */
  private async assemble(upload: AttachmentUpload) {
    if (upload.received < upload.size) {
      throw uploadIncomplete();
    }
    const parts: string[] = [];
    let total = 0;
    for await (const entry of this.disk.listAll({
      prefix: partsPrefix(upload.key),
    })) {
      if (entry.key !== partKey(upload.key, total)) {
        continue; // a chunk that never got its place
      }
      parts.push(entry.key);
      total += entry.size;
    }
    if (total !== upload.size) {
      await this.discard(upload);
      throw new BadRequestException({
        code: 'attachment_upload_mismatch',
        message: 'The chunks received are not the size that was announced.',
      });
    }
    const disk = this.disk;
    await disk.put(
      upload.key,
      (async function* () {
        for (const part of parts) {
          yield* (await disk.get(part)).body;
        }
      })(),
      { contentType: upload.contentType },
    );
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new ServiceUnavailableException({
        code: 'presigned_uploads_unavailable',
        message:
          'Direct uploads need STORAGE_DRIVER=s3 on this server: upload the file to the record with a multipart POST instead.',
      });
    }
  }

  /**
   * The caller's own upload for this record, marked as being completed. One
   * atomic update, so of two parallel requests one gets it and the other a
   * 409; a claim older than CLAIM_MS (a request that died) is taken over.
   */
  private async claim(
    principal: Principal,
    record: RecordRef,
    uploadId: string,
  ) {
    const mine = and(
      eq(attachmentUploads.id, uploadId),
      eq(attachmentUploads.subject, record.subject),
      eq(attachmentUploads.recordId, record.recordId),
      eq(attachmentUploads.uploadedBy, principalKey(principal)),
      // A completed upload is the client's no more: 404, as when its row was deleted.
      isNull(attachmentUploads.completedAt),
    );
    const [claimed] = await this.db
      .update(attachmentUploads)
      .set({ completingAt: new Date() })
      .where(
        and(
          mine,
          or(
            isNull(attachmentUploads.completingAt),
            lt(attachmentUploads.completingAt, new Date(Date.now() - CLAIM_MS)),
          ),
        ),
      )
      .returning();
    if (claimed) {
      return claimed;
    }
    const [existing] = await this.db
      .select({ id: attachmentUploads.id })
      .from(attachmentUploads)
      .where(mine);
    if (!existing) {
      throw new NotFoundException({
        code: 'attachment_upload_not_found',
        message: `Upload ${uploadId} not found.`,
      });
    }
    throw new ConflictException({
      code: 'attachment_upload_in_progress',
      message: 'This upload is being completed by another request.',
    });
  }

  /** Lets the upload be completed again (a claim from a request that is done with it). */
  private async release(upload: AttachmentUpload) {
    await this.db
      .update(attachmentUploads)
      .set({ completingAt: null })
      .where(eq(attachmentUploads.id, upload.id))
      .catch((error: unknown) =>
        this.logger.warn('An upload was not released', {
          upload: upload.id,
          error: String(error),
        }),
      );
  }

  /** Deletes an object nobody is to keep; a failure is logged, the sweep or the next try deals with it. */
  private async forget(key: string) {
    await this.disk.delete(key).catch((error: unknown) =>
      this.logger.warn('An upload object was not deleted', {
        key,
        error: String(error),
      }),
    );
  }

  /**
   * Deletes a refused upload: the object, then the row. A failed delete
   * leaves the row, so the sweep tries again, rather than an object nothing
   * points at.
   */
  private async discard(upload: AttachmentUpload) {
    try {
      await this.disk.delete(await uploadObjects(this.disk, upload));
    } catch (error) {
      this.logger.warn('A refused upload was not deleted', {
        upload: upload.id,
        error: String(error),
      });
      return;
    }
    await this.db
      .delete(attachmentUploads)
      .where(eq(attachmentUploads.id, upload.id))
      .catch((error: unknown) =>
        this.logger.warn('An upload row was not deleted', {
          upload: upload.id,
          error: String(error),
        }),
      );
  }
}

/** A resumable session as the API shows it. */
const sessionView = (row: AttachmentUpload): UploadSessionView => ({
  uploadId: row.id,
  name: row.name,
  size: row.size,
  contentType: row.contentType,
  received: row.received,
  chunkSize: UPLOAD_CHUNK_BYTES,
  expiresAt: row.expiresAt.toISOString(),
});

const offsetMismatch = (received: number) =>
  new ConflictException({
    code: 'attachment_upload_offset_mismatch',
    message: `The next chunk starts at byte ${received}: send it from there.`,
    received,
  });
