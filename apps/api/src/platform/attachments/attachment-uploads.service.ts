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
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk, StorageFileNotFoundError } from '@nestjs/storage';
import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import { buffer } from 'node:stream/consumers';
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
import {
  assertDeclaredType,
  ATTACHMENT_SAMPLE_BYTES,
  detectUploadedType,
  directUploadType,
  isAllowedType,
  sameType,
} from './attachment-types.js';
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

/** The most uploads one uploader may have announced and not completed: the objects they leave are not counted by the storage quota. */
export const MAX_PENDING_UPLOADS = 100;

/** What `verify()` makes of an object: the file is fine, or a refusal (and whether the upload is kept for another try). */
type Verdict =
  | { ok: true; size: number; contentType: string }
  | { ok: false; keep: boolean; error: HttpException };

/**
 * Uploads that go straight from the client to the object store
 * (`STORAGE_DRIVER=s3`), not through the API's memory and time limits:
 *
 * 1. `presign()` checks the right to attach files to the record and the
 *    announced size and type, picks the key itself (under the tenant's
 *    prefix: never the client's), signs a PUT URL bound to that key, size and
 *    `Content-Type` for ten minutes, and remembers it (`attachment_uploads`).
 * 2. The client PUTs the file to the URL.
 * 3. `complete()` verifies the object (its size and type by HEAD, its
 *    first bytes by a ranged GET, as the upload through the API reads them),
 *    then creates the attachment through `AttachmentsService.upload()`, the
 *    same path as an upload through the API: quota, tenant, audit entry,
 *    malware scan and image renditions. An object that fails verification
 *    is deleted.
 *
 * An object that is never completed is swept with its row (AttachmentSweepJob).
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
   * `attachment_uploads_pending` past MAX_PENDING_UPLOADS.
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
      const [pending] = await tx
        .select({ pending: count() })
        .from(attachmentUploads)
        .where(eq(attachmentUploads.uploadedBy, uploadedBy));
      if ((pending?.pending ?? 0) >= MAX_PENDING_UPLOADS) {
        throw new HttpException(
          {
            code: 'attachment_uploads_pending',
            message: `You have ${MAX_PENDING_UPLOADS} uploads announced and not completed: complete or wait for them to expire.`,
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
   * Creates the attachment of an upload the client has PUT: verifies the
   * object, then `AttachmentsService.upload()` stores the row, audits it and
   * queues the scan and the renditions. The upload is the caller's own
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
    let verdict: Verdict;
    try {
      verdict = await this.verify(upload);
    } catch (error) {
      // The store could not be asked: nothing is known of the file, try again later.
      await this.release(upload);
      throw error;
    }
    if (!verdict.ok) {
      await (verdict.keep ? this.release(upload) : this.discard(upload));
      throw verdict.error;
    }
    try {
      return await this.attachments.upload(
        principal,
        record,
        {
          key: upload.key,
          originalname: upload.name,
          size: verdict.size,
          // What the bytes are, as for an upload through the API.
          contentType: verdict.contentType,
        },
        ip,
        // With the attachment, or not at all: the upload row is gone when the attachment exists.
        {
          within: (tx) =>
            tx
              .delete(attachmentUploads)
              .where(eq(attachmentUploads.id, upload.id)),
        },
      );
    } catch (error) {
      // upload() deleted the object. The row has nothing left to wait for.
      await this.db
        .delete(attachmentUploads)
        .where(eq(attachmentUploads.id, upload.id))
        .catch((failure: unknown) =>
          this.logger.warn('An upload row was not deleted', {
            upload: upload.id,
            error: String(failure),
          }),
        );
      throw error;
    }
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

  /**
   * Reads the object back and compares it with what was announced: its size
   * and type by HEAD, then the first bytes by a ranged GET, whose type
   * (never the client's word) must be allowed and not contradict the one
   * declared. Throws only when the store cannot be asked.
   */
  private async verify(upload: AttachmentUpload): Promise<Verdict> {
    const limits = attachmentLimits(this.config);
    const refuse = (error: HttpException): Verdict => ({
      ok: false,
      keep: false,
      error,
    });
    let file;
    try {
      file = await this.disk.stat(upload.key);
    } catch (error) {
      if (error instanceof StorageFileNotFoundError) {
        return {
          ok: false,
          keep: true,
          error: new ConflictException({
            code: 'attachment_upload_incomplete',
            message:
              'The file has not arrived in storage: PUT it to the upload URL first.',
          }),
        };
      }
      throw error;
    }
    // The limit may be lower than when the URL was signed.
    if (file.size > limits.maxBytes) {
      return refuse(new PayloadTooLargeException('File too large'));
    }
    if (
      file.size !== upload.size ||
      !sameType(file.contentType, upload.contentType)
    ) {
      return refuse(
        new BadRequestException({
          code: 'attachment_upload_mismatch',
          message:
            'The uploaded file is not the size and type that were announced.',
        }),
      );
    }
    const { body } = await this.disk.get(upload.key, {
      range: { start: 0, end: ATTACHMENT_SAMPLE_BYTES - 1 },
    });
    const sample = await buffer(body);
    const detected = detectUploadedType(sample, upload.contentType);
    if (!detected || !isAllowedType(detected, limits.types)) {
      return refuse(
        new UnsupportedMediaTypeException(
          `File type not allowed. Allowed types: ${limits.types.join(', ')}`,
        ),
      );
    }
    try {
      assertDeclaredType(upload.contentType, detected);
    } catch (error) {
      return refuse(error as HttpException);
    }
    return { ok: true, size: file.size, contentType: detected };
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
