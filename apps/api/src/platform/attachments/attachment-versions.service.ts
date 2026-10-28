import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk, type StoredUpload } from '@nestjs/storage';
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { assertUnchanged } from '../../core/http/etag.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { renditionKeys } from '../images/renditions.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import { AttachmentImagesQueue } from './attachment-images.queue.js';
import { AttachmentScanQueue } from './attachment-scan.queue.js';
import type {
  AttachmentVersionView,
  AttachmentView,
} from './attachment.schemas.js';
import {
  assertOwnFile,
  attachmentKey,
  AttachmentsService,
  DOWNLOAD_LINK_TTL,
  details,
  fileName,
  view,
} from './attachments.service.js';
import {
  type Attachment,
  attachments,
  attachmentVersions,
} from './attachments.tables.js';

/** The most versions one attachment keeps, the current one included: the bytes of all of them count in the tenant's storage. */
export const MAX_ATTACHMENT_VERSIONS = 100;

/** The file that becomes an attachment's current version. */
interface NextVersion {
  key: string;
  name: string;
  size: number;
  contentType: string;
  note: string | null;
}

/**
 * An attachment's history (docs/attachments.md, "Versions"). The attachment
 * row is its current file; replacing it, or restoring an earlier one, moves
 * the file it held to `attachment_versions` and puts the new one in its
 * place under the next version number, in one transaction with the audit
 * entry. Nothing is overwritten: the earlier bytes stay where they are until
 * the attachment itself goes. The new current file goes through everything
 * an upload does (the type from its bytes, the size limit, the quota, the
 * malware scan, the image renditions); a restored version is copied to a
 * file of its own and scanned again.
 *
 * Distinct from a record's field revisions (platform/revisions): those
 * are the record's values, these the bytes of one file.
 */
@Injectable()
export class AttachmentVersionsService {
  private readonly logger = new Logger(AttachmentVersionsService.name);

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly scans: AttachmentScanQueue,
    private readonly images: AttachmentImagesQueue,
    private readonly quotas: TenantQuotas,
  ) {}

  /** The attachment's versions, newest first, the current one (`current: true`) on top. Whoever may read its record. */
  async list(
    principal: Principal,
    id: string,
  ): Promise<{ items: AttachmentVersionView[] }> {
    const current = await this.attachments.findReadable(principal, id);
    const earlier = await this.db
      .select()
      .from(attachmentVersions)
      .where(eq(attachmentVersions.attachmentId, id))
      .orderBy(desc(attachmentVersions.version));
    return {
      items: [
        {
          version: current.version,
          current: true,
          name: current.name,
          size: current.size,
          contentType: current.contentType,
          uploadedBy: current.uploadedBy,
          note: current.revisionNote,
          uploadedAt: current.versionedAt.toISOString(),
        },
        ...earlier.map((row) => ({
          version: row.version,
          current: false,
          name: row.name,
          size: row.size,
          contentType: row.contentType,
          uploadedBy: row.uploadedBy,
          note: row.note,
          uploadedAt: row.uploadedAt.toISOString(),
        })),
      ],
    };
  }

  /** A signed link to the file of one version, as a download of the attachment's: whoever may read its record. */
  async download(principal: Principal, id: string, version: number) {
    const current = await this.attachments.findReadable(principal, id);
    if (version === current.version) {
      return this.attachments.download(principal, id);
    }
    const [row] = await this.db
      .select()
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.attachmentId, id),
          eq(attachmentVersions.version, version),
        ),
      );
    if (!row) {
      throw versionNotFound(id, version);
    }
    // Clean when it was archived (a file is replaced only once scanned): served as an attachment, never inline.
    const url = await this.disk.signedUrl(row.key, {
      expiresIn: DOWNLOAD_LINK_TTL,
      filename: row.name,
      disposition: 'attachment',
    });
    return { url };
  }

  /**
   * Replaces the attachment's file by `file` (already on the disk, checked
   * by the upload interceptor like any upload), keeping the old one as the
   * previous version. Who may change the record. `ifMatch` is the
   * attachment's ETag as read: 412 `precondition_failed` when it changed
   * since, which also catches two replacements racing. 409
   * `attachment_busy` while the current file is being scanned or made into
   * renditions (those jobs work on the file that is there), 409
   * `attachment_locked` for an issued document, 409
   * `attachment_versions_limit` past MAX_ATTACHMENT_VERSIONS, 422
   * `quota_exceeded` when the tenant has no room for both files.
   */
  async replace(
    principal: Principal,
    record: RecordRef,
    id: string,
    file: Pick<StoredUpload, 'key' | 'originalname' | 'size' | 'contentType'>,
    options: { ifMatch?: string; note?: string; ip?: string },
  ): Promise<AttachmentView> {
    try {
      assertOwnFile(file.key);
      await this.attachments.assertCanUpload(principal, record);
      const current = await this.own(principal, record, id);
      assertUnchanged(options.ifMatch, view(current));
      const row = await this.swap(
        principal,
        current,
        {
          key: file.key,
          name: fileName(file.originalname),
          size: file.size,
          contentType: file.contentType,
          note: options.note?.trim() || null,
        },
        'attachment.replaced',
        {},
        options.ip,
      );
      return row;
    } catch (error) {
      await this.disk.delete(file.key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Makes an earlier version the current file again, as a new version (the
   * history only grows): its bytes are copied to a file of their own, and
   * scanned again. Who may change the record, audited
   * `attachment.version-restored`. 404 for a version that does not exist,
   * 400 for the current one; the other errors are `replace()`'s.
   */
  async restore(
    principal: Principal,
    id: string,
    version: number,
    options: { ifMatch?: string; note?: string; ip?: string },
  ): Promise<AttachmentView> {
    const found = await this.attachments.findReadable(principal, id);
    await this.attachments.assertCanUpload(principal, found);
    const current = await this.own(principal, found, id);
    assertUnchanged(options.ifMatch, view(current));
    if (version === current.version) {
      throw new BadRequestException({
        code: 'attachment_version_current',
        message: 'This is the current version: nothing to restore.',
      });
    }
    const [earlier] = await this.db
      .select()
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.attachmentId, id),
          eq(attachmentVersions.version, version),
        ),
      );
    if (!earlier) {
      throw versionNotFound(id, version);
    }
    // A copy of its own: the version stays what it was, whatever happens to the new current file.
    const key = attachmentKey(principal);
    await this.disk.copy(earlier.key, key);
    try {
      return await this.swap(
        principal,
        current,
        {
          key,
          name: earlier.name,
          size: earlier.size,
          contentType: earlier.contentType,
          note: options.note?.trim() || `Restored from version ${version}`,
        },
        'attachment.version-restored',
        { restoredVersion: version },
        options.ip,
      );
    } catch (error) {
      await this.disk.delete(key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The infected current file of an attachment that has earlier versions is
   * dropped and the latest earlier version becomes the current one again,
   * instead of the attachment (and its history) being deleted. Called in the
   * scan job's transaction; returns the row now current, or null when there
   * is no earlier version (the attachment is deleted as before) or the file
   * was no longer pending.
   */
  async revertRejected(
    tx: Transaction,
    rejected: Attachment,
  ): Promise<Attachment | null> {
    const [previous] = await tx
      .select()
      .from(attachmentVersions)
      .where(eq(attachmentVersions.attachmentId, rejected.id))
      .orderBy(desc(attachmentVersions.version))
      .limit(1);
    if (!previous) {
      return null;
    }
    const [reverted] = await tx
      .update(attachments)
      .set({
        key: previous.key,
        name: previous.name,
        size: previous.size,
        contentType: previous.contentType,
        uploadedBy: previous.uploadedBy,
        revisionNote: previous.note,
        version: previous.version,
        versionedAt: previous.uploadedAt,
        // It was clean when archived.
        scanStatus: 'clean',
        renditionStatus: this.images.wants(previous.contentType)
          ? 'pending'
          : null,
        renditions: {},
      })
      .where(
        and(
          eq(attachments.id, rejected.id),
          eq(attachments.scanStatus, 'pending'),
        ),
      )
      .returning();
    if (!reverted) {
      return null;
    }
    await tx
      .delete(attachmentVersions)
      .where(eq(attachmentVersions.id, previous.id));
    return reverted;
  }

  /** The attachment of this record, or a 404; never an issued document (409). */
  private async own(principal: Principal, record: RecordRef, id: string) {
    const current = await this.attachments.findReadable(principal, id);
    if (
      current.subject !== record.subject ||
      current.recordId !== record.recordId
    ) {
      throw new NotFoundException(`Attachment ${id} not found.`);
    }
    if (current.locked) {
      throw new ConflictException({
        code: 'attachment_locked',
        message: 'An issued document never changes: it has no versions.',
      });
    }
    if (
      current.scanStatus === 'pending' ||
      current.renditionStatus === 'pending'
    ) {
      throw new ConflictException({
        code: 'attachment_busy',
        message:
          'This file is still being scanned or processed: try again in a moment.',
      });
    }
    if (current.version >= MAX_ATTACHMENT_VERSIONS) {
      throw new ConflictException({
        code: 'attachment_versions_limit',
        message: `An attachment keeps at most ${MAX_ATTACHMENT_VERSIONS} versions: remove it, or upload the file as a new attachment.`,
      });
    }
    return current;
  }

  /**
   * The one place a new current file is put in: the quota, the row's change
   * (only if still the version, and still idle, that the caller read), the
   * earlier file archived and the audit entry, in one transaction; then the
   * scan or the renditions queued and the superseded renditions deleted.
   */
  private async swap(
    principal: Principal,
    current: Attachment,
    next: NextVersion,
    action: string,
    extra: Record<string, unknown>,
    ip: string | undefined,
  ): Promise<AttachmentView> {
    const row = await inTransaction(this.txHost, async (tx) => {
      await this.quotas.assertRoom(
        tx,
        requireTenantId(),
        'storageBytes',
        next.size,
      );
      const [updated] = await tx
        .update(attachments)
        .set({
          key: next.key,
          name: next.name,
          size: next.size,
          contentType: next.contentType,
          uploadedBy: principalKey(principal),
          revisionNote: next.note,
          version: current.version + 1,
          versionedAt: new Date(),
          scanStatus: this.scans.enabled ? 'pending' : 'clean',
          renditionStatus: this.images.wants(next.contentType)
            ? 'pending'
            : null,
          renditions: {},
        })
        .where(
          and(
            eq(attachments.id, current.id),
            eq(attachments.version, current.version),
            eq(attachments.locked, false),
            eq(attachments.scanStatus, 'clean'),
            or(
              isNull(attachments.renditionStatus),
              ne(attachments.renditionStatus, 'pending'),
            ),
          ),
        )
        .returning();
      if (!updated) {
        throw new PreconditionFailedException({
          code: 'precondition_failed',
          message:
            'The attachment changed since you read it: read it again, then retry with its ETag.',
        });
      }
      await tx.insert(attachmentVersions).values({
        attachmentId: current.id,
        version: current.version,
        key: current.key,
        name: current.name,
        size: current.size,
        contentType: current.contentType,
        uploadedBy: current.uploadedBy,
        note: current.revisionNote,
        uploadedAt: current.versionedAt,
      });
      await this.audit.record(
        principal,
        {
          action,
          targetType: 'attachment',
          targetId: current.id,
          details: {
            ...details(updated),
            previousVersion: current.version,
            version: updated.version,
            note: next.note,
            ...extra,
          },
          ip,
        },
        tx,
      );
      return updated;
    });
    if (row.scanStatus === 'pending') {
      await this.scans.enqueue(row.id);
    } else if (row.renditionStatus === 'pending') {
      await this.images.enqueue(row.id);
    }
    this.attachments.changed(principal, row, row.id, 'processed');
    // The superseded file's renditions are derived: only the file itself is history.
    const keys = renditionKeys(current.renditions);
    if (keys.length > 0) {
      await this.disk.delete(keys).catch((error: unknown) =>
        this.logger.warn('Superseded renditions were not deleted', {
          keys,
          error: String(error),
        }),
      );
    }
    return view(row);
  }
}

const versionNotFound = (id: string, version: number) =>
  new NotFoundException({
    code: 'attachment_version_not_found',
    message: `Attachment ${id} has no version ${version}.`,
  });
