import {
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
    await this.attachments.assertCanUpload(principal, record);
    const limits = attachmentLimits(this.config);
    if (request.size > limits.maxBytes) {
      throw new PayloadTooLargeException('File too large');
    }
    // The type the URL is signed for. The bytes are read again on completion;
    // this keeps the store from serving what we would not accept.
    const contentType = directUploadType(request.contentType);
    if (!contentType) {
      throw new UnsupportedMediaTypeException(
        "Declare the file's type (contentType): a direct upload is signed for it.",
      );
    }
    if (!isAllowedType(contentType, limits.types)) {
      throw new UnsupportedMediaTypeException(
        `File type not allowed. Allowed types: ${limits.types.join(', ')}`,
      );
    }
    const tenantId = requireTenantId();
    const uploadedBy = principalKey(principal);
    // The server's key, under the tenant's prefix, the way an upload through the API gets one.
    const key = attachmentKey(principal);
    const signed = await this.disk.signedUpload(key, {
      contentType,
      contentLength: request.size,
      expiresIn: UPLOAD_LINK_TTL,
    });
    const row = await inTransaction(this.txHost, async (tx) => {
      // Early, so a client does not send 25 MB to be refused on completion.
      await this.quotas.assertRoom(tx, tenantId, 'storageBytes', request.size);
      // Only the uploads that can still be completed through their URL: an
      // expired one (a PUT that failed, a tab closed) frees its place, though
      // the sweep deletes its row only at night.
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
          key,
          name: request.name,
          size: request.size,
          contentType,
          uploadedBy,
          expiresAt: signed.expiresAt,
        })
        .returning();
      return inserted!;
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
    this.assertEnabled();
    // Checked again: the right may have gone since the URL was signed.
    await this.attachments.assertCanUpload(principal, record);
    const upload = await this.claim(principal, record, uploadId);
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
    return attachment;
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
      await this.disk.delete(upload.key);
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
