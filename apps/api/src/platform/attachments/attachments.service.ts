import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk, type StoredUpload } from '@nestjs/storage';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
import { z } from 'zod';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  requireTenantId,
  TenantScopeMissingError,
} from '../../core/tenancy/tenant-scope.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { LegalHoldsService } from '../../iam/holds/legal-holds.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import { RECORD_EVENTS, RecordActivity } from '../realtime/record-activity.js';
import { isTenantFileKey, tenantFileKey } from '../storage/storage.config.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import {
  publicRenditions,
  type RenditionName,
  renditionKeys,
} from '../images/renditions.js';
import { AttachmentImagesQueue } from './attachment-images.queue.js';
import { AttachmentScanQueue } from './attachment-scan.queue.js';
import { ATTACHMENT_LIST } from './attachment.list.js';
import type { AttachmentView } from './attachment.schemas.js';
import { AttachmentsRegistry } from './attachments.registry.js';
import {
  type Attachment,
  attachments,
  attachmentUploads,
  attachmentVersions,
} from './attachments.tables.js';

/** How long a download link works. */
export const DOWNLOAD_LINK_TTL = '5m';

/**
 * The types `?inline=true` shows in the browser: PDF only, which the
 * browser's viewer renders without running the file's scripts in this
 * origin. Never HTML, SVG, XML or anything else that can script (the
 * storage package would refuse those inline anyway); images and text stay
 * downloads too, as there is no need to show them from here.
 */
export const INLINE_TYPES: ReadonlySet<string> = new Set(['application/pdf']);

/** The uploader of an attachment whose account was deleted. */
export const ANONYMIZED_UPLOADER = 'anonymized';

/**
 * Where an upload of `principal` goes on the private disk: under its
 * tenant's prefix, `tenants/<id>/attachments/<random><.ext>`
 * (docs/tenancy.md), so a tenant's files are one prefix to export or
 * delete. Its tenant is the principal's (the request's), never the client's
 * say; a principal without one gets 403 tenant_required.
 */
export function attachmentKey(principal: Principal, extension = '') {
  const tenantId =
    principal.kind === 'system' ? requireTenantId() : principal.tenantId;
  if (!tenantId) {
    throw new TenantScopeMissingError('An upload needs a tenant.');
  }
  return tenantFileKey(tenantId, `attachments/${randomUUID()}${extension}`);
}

/** A file of another tenant (or outside any) can't become this tenant's attachment. */
export function assertOwnFile(key: string) {
  if (!isTenantFileKey(requireTenantId('An attachment'), key)) {
    throw new Error(`File ${key} is not under this tenant's prefix.`);
  }
}

/**
 * Files attached to records of the features that register an
 * AttachmentTarget. The bytes go to the private disk (StorageDisk) as
 * they arrive (AttachmentUpload), the row here, with its audit entry, in
 * one transaction; downloads are short-lived signed links. Who may see a
 * record's attachments, and who may add them, is the feature's answer
 * (`canRead`, `canWrite`); an uploader may always remove their own.
 *
 * After an upload or a removal commits, the record's open pages hear of
 * it (`record.attachments.changed`, RecordActivity); a caller that
 * attaches in its own transaction (`attachStored`) calls `changed()`
 * after its commit.
 *
 * Personal data: a user's uploads (the rows, not the files) are part of
 * their data export; when their account is deleted the rows stay, the
 * uploader becoming `anonymized`.
 */
@Injectable()
export class AttachmentsService implements PersonalDataSource {
  readonly name = 'attachments';
  private readonly logger = new Logger(AttachmentsService.name);

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly registry: AttachmentsRegistry,
    private readonly activity: RecordActivity,
    private readonly scans: AttachmentScanQueue,
    private readonly images: AttachmentImagesQueue,
    personalData: PersonalDataRegistry,
    private readonly quotas: TenantQuotas,
    private readonly holds: LegalHoldsService,
  ) {
    personalData.register(this);
    // The tenant's stored bytes: uploads, issued documents (their PDFs are attachments) and earlier versions.
    quotas.count('storageBytes', async (db) => {
      const [row] = await db
        .select({
          bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::float8`,
        })
        .from(attachments);
      // The earlier versions of attachments are stored bytes too.
      const [earlier] = await db
        .select({
          bytes: sql<number>`coalesce(sum(${attachmentVersions.size}), 0)::float8`,
        })
        .from(attachmentVersions);
      return (row?.bytes ?? 0) + (earlier?.bytes ?? 0);
    });
  }

  /**
   * A 404 unless the principal may read the record, and every one of
   * `fields` of it (a generated file's: field-level permissions).
   */
  async assertCanRead(
    principal: Principal,
    record: RecordRef,
    fields?: readonly string[] | null,
  ) {
    const target = this.registry.get(record.subject);
    if (
      !target ||
      !z.uuid().safeParse(record.recordId).success ||
      !(await target.canRead(principal, record.recordId)) ||
      (fields?.length &&
        !(await target.canReadFields?.(principal, record.recordId, fields)))
    ) {
      throw new NotFoundException(
        `${record.subject} ${record.recordId} not found.`,
      );
    }
    return target;
  }

  /** A 404 unless the principal may read the record, a 403 unless they may attach files to it. */
  async assertCanUpload(principal: Principal, record: RecordRef) {
    const target = await this.assertCanRead(principal, record);
    if (!(await target.canWrite(principal, record.recordId))) {
      throw new ForbiddenException(
        `You may not attach files to ${record.subject} ${record.recordId}.`,
      );
    }
  }

  /** One attachment, as the API shows it: whoever may read its record, else a 404. */
  async get(principal: Principal, id: string): Promise<AttachmentView> {
    return view(await this.findReadable(principal, id));
  }

  /** A page of the record's attachments, newest first. */
  async list(principal: Principal, record: RecordRef, query: ListQuery) {
    await this.assertCanRead(principal, record);
    const where = and(
      eq(attachments.subject, record.subject),
      eq(attachments.recordId, record.recordId),
      ATTACHMENT_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(attachments)
        .where(and(where, afterCursor(attachments.id, query)))
        .orderBy(...pageOrder(attachments.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, attachments, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  /**
   * Records a file the upload stored (`file.key`) as the record's
   * attachment, audited `attachment.added`. Refused or failed, the file
   * is deleted from the disk. The one way an uploaded file becomes an
   * attachment, whether it came through the API (AttachmentUpload) or went
   * straight to the object store (AttachmentUploadsService): the quota, the
   * tenant, the audit entry, the malware scan and the image renditions are
   * this method's, so a file never gets a weaker path. `within` runs in the
   * transaction, after the row and its audit entry.
   */
  async upload(
    principal: Principal,
    record: RecordRef,
    file: Pick<StoredUpload, 'key' | 'originalname' | 'size' | 'contentType'>,
    ip?: string,
    { within }: { within?: (tx: Transaction) => Promise<unknown> } = {},
  ): Promise<AttachmentView> {
    try {
      await this.assertCanUpload(principal, record);
      assertOwnFile(file.key);
      const row = await inTransaction(this.txHost, async (tx) => {
        // 422 `quota_exceeded` past the tenant's storage; the catch below deletes the file.
        await this.quotas.assertRoom(
          tx,
          requireTenantId(),
          'storageBytes',
          file.size,
        );
        const [row] = await tx
          .insert(attachments)
          .values({
            subject: record.subject,
            recordId: record.recordId,
            key: file.key,
            // The client's name, for showing and downloading: never a path.
            name: fileName(file.originalname),
            size: file.size,
            contentType: file.contentType,
            uploadedBy: principalKey(principal),
            // Off (the default): clean at once, as ever. Otherwise it waits for its scan.
            scanStatus: this.scans.enabled ? 'pending' : 'clean',
            // An image waits for its renditions (once it is clean); anything else has none.
            renditionStatus: this.images.wants(file.contentType)
              ? 'pending'
              : null,
          })
          .returning();
        await this.audit.record(
          principal,
          {
            action: 'attachment.added',
            targetType: 'attachment',
            targetId: row!.id,
            details: details(row!),
            ip,
          },
          tx,
        );
        await within?.(tx);
        return row!;
      });
      if (row.scanStatus === 'pending') {
        // The scan queues the image job when it finds the file clean.
        await this.scans.enqueue(row.id);
      } else if (row.renditionStatus === 'pending') {
        await this.images.enqueue(row.id);
      }
      this.changed(principal, row, row.id, 'added');
      return view(row);
    } catch (error) {
      await this.disk.delete(file.key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Records a file the app wrote to the disk itself (`key`) as the record's
   * attachment, audited `attachment.added`, in the caller's transaction: a
   * generated document is linked to its record in the transaction that
   * completes its job, or the file has no row (and the caller deletes it).
   * `locked`: an issued document, which nobody removes.
   */
  async attachStored(
    principal: Principal,
    record: RecordRef,
    file: { key: string; name: string; size: number; contentType: string },
    {
      locked = false,
      fields = null,
    }: { locked?: boolean; fields?: string[] | null } = {},
  ): Promise<AttachmentView> {
    assertOwnFile(file.key);
    return inTransaction(this.txHost, async (tx) => {
      await this.quotas.assertRoom(
        tx,
        requireTenantId(),
        'storageBytes',
        file.size,
      );
      const [row] = await tx
        .insert(attachments)
        .values({
          subject: record.subject,
          recordId: record.recordId,
          key: file.key,
          name: fileName(file.name),
          size: file.size,
          contentType: file.contentType,
          uploadedBy: principalKey(principal),
          locked,
          fields,
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'attachment.added',
          targetType: 'attachment',
          targetId: row!.id,
          details: { ...details(row!), locked, fields },
        },
        tx,
      );
      return view(row!);
    });
  }

  /**
   * A signed link to the file (DOWNLOAD_LINK_TTL), downloading under its
   * name. `inline`: shown in the browser instead (`Content-Disposition:
   * inline`), for a PDF only (INLINE_TYPES); any other type stays an
   * attachment. The disposition is part of what the link signs (the local
   * disk's claims, S3's `response-content-disposition`), so a client can't
   * turn one link into the other. `rendition`: the link to the image's
   * `thumb` or `preview` instead (a WebP, inline), a 404 when it has none.
   */
  async download(
    principal: Principal,
    id: string,
    {
      inline = false,
      rendition,
    }: { inline?: boolean; rendition?: RenditionName } = {},
  ) {
    const row = await this.findReadable(principal, id);
    if (row.scanStatus === 'pending') {
      throw new ConflictException({
        code: 'attachment_scan_pending',
        message:
          'This file is still being scanned for malware: try again in a moment.',
      });
    }
    if (rendition) {
      const file = row.renditions[rendition];
      if (!file) {
        throw new NotFoundException({
          code: 'attachment_rendition_not_found',
          message:
            row.renditionStatus === 'pending'
              ? `The ${rendition} of attachment ${id} is not made yet: try again in a moment.`
              : `Attachment ${id} has no ${rendition}.`,
        });
      }
      // Our own WebP, always safe to show: the renditions are for `<img>`s and previews.
      const url = await this.disk.signedUrl(file.key, {
        expiresIn: DOWNLOAD_LINK_TTL,
        filename: renditionName(row.name, rendition),
        disposition: 'inline',
      });
      return { url };
    }
    const url = await this.disk.signedUrl(row.key, {
      expiresIn: DOWNLOAD_LINK_TTL,
      filename: row.name,
      disposition:
        inline && INLINE_TYPES.has(row.contentType) ? 'inline' : 'attachment',
    });
    return { url };
  }

  /**
   * Removes an attachment, row and files (the renditions too), audited `attachment.removed`: the
   * uploader's own, or any with `canWrite` on the record. Never an issued
   * document (`locked`): 409 `attachment_locked`.
   */
  async remove(principal: Principal, id: string, ip?: string) {
    const row = await this.findReadable(principal, id);
    if (row.locked) {
      throw new ConflictException({
        code: 'attachment_locked',
        message:
          'An issued document cannot be removed: it stays with its record.',
      });
    }
    if (
      row.uploadedBy !== principalKey(principal) &&
      !(await this.registry.get(row.subject)!.canWrite(principal, row.recordId))
    ) {
      throw new ForbiddenException('You may not remove this attachment.');
    }
    let versionKeys: string[] = [];
    const removed = await inTransaction(this.txHost, async (tx) => {
      // A held record keeps its files, every version of them (a 409 `legal_hold`).
      await this.holds.assertNotHeld(row.subject, [row.recordId], tx);
      versionKeys = (
        await tx
          .select({ key: attachmentVersions.key })
          .from(attachmentVersions)
          .where(eq(attachmentVersions.attachmentId, row.id))
      ).map((version) => version.key);
      const [gone] = await tx
        .delete(attachments)
        .where(and(eq(attachments.id, row.id), eq(attachments.locked, false)))
        .returning();
      if (!gone) {
        // Removed meanwhile: nothing to audit.
        throw new NotFoundException(`Attachment ${id} not found.`);
      }
      await this.audit.record(
        principal,
        {
          action: 'attachment.removed',
          targetType: 'attachment',
          targetId: row.id,
          details: details(row),
          ip,
        },
        tx,
      );
      return gone;
    });
    this.changed(principal, row, row.id, 'removed');
    // After the commit: a failed delete leaves a file nothing points at, never a row without its file.
    // The files of the row that was deleted, not of the one read above: an
    // image job may have replaced the original and added renditions since.
    const keys = [
      removed.key,
      ...renditionKeys(removed.renditions),
      ...versionKeys,
    ];
    await this.disk.delete(keys).catch((error: unknown) =>
      this.logger.warn('An attachment file was not deleted', {
        keys,
        error: String(error),
      }),
    );
  }

  /**
   * After the commit of an attachment's change: `record.attachments.changed`
   * to the record's watchers and `by`'s other tabs who may read it
   * (RecordActivity). Not awaited: the answer doesn't wait for the
   * permission checks, and a failure is logged.
   */
  changed(
    by: Principal,
    record: RecordRef,
    attachmentId: string,
    action: 'added' | 'removed' | 'scanned' | 'processed',
  ) {
    const target = this.registry.get(record.subject);
    if (!target) return;
    const ref = { subject: record.subject, recordId: record.recordId };
    void this.activity.push(
      ref,
      RECORD_EVENTS.attachmentsChanged,
      { attachmentId, action },
      { by, canRead: (principal) => target.canRead(principal, ref.recordId) },
    );
  }

  /** The user's uploads, for their data export: the rows, not the files. */
  async *rows(user: UserPrincipal) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.uploadedBy, principalKey(user)),
            cursor ? lt(attachments.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(attachments.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows.map(({ key: _key, renditions, ...row }) => ({
        ...row,
        renditions: publicRenditions(renditions),
      }));
      cursor = rows[rows.length - 1]!.id;
    }
  }

  /** Their account is deleted: the files stay with their records, uploaded by nobody. */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .update(attachments)
      .set({ uploadedBy: ANONYMIZED_UPLOADER })
      .where(eq(attachments.uploadedBy, principalKey(user)));
    await tx
      .update(attachmentVersions)
      .set({ uploadedBy: ANONYMIZED_UPLOADER })
      .where(eq(attachmentVersions.uploadedBy, principalKey(user)));
    // Uploads announced and not completed (direct uploads): nobody can complete them now;
    // the sweep deletes them within a day, and they are not in the export.
    await tx
      .update(attachmentUploads)
      .set({ uploadedBy: ANONYMIZED_UPLOADER })
      .where(eq(attachmentUploads.uploadedBy, principalKey(user)));
  }

  /**
   * A shared record's files (platform/shares), as `principal` (the link's
   * maker) may read them: scanned, and only those that show no field
   * outside `fields` (an issued PDF of a field the link leaves out stays
   * out). Oldest first.
   */
  async sharedFiles(
    principal: Principal,
    record: RecordRef,
    fields: readonly string[],
  ) {
    await this.assertCanRead(principal, record);
    const rows = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.subject, record.subject),
          eq(attachments.recordId, record.recordId),
          eq(attachments.scanStatus, 'clean'),
        ),
      )
      .orderBy(attachments.id);
    return rows
      .filter((row) => (row.fields ?? []).every((f) => fields.includes(f)))
      .map(({ id, name, size, contentType }) => ({
        id,
        name,
        size,
        contentType,
      }));
  }

  /** The download link of one of `sharedFiles()`, or a 404 for any other file. */
  async sharedDownload(
    principal: Principal,
    record: RecordRef,
    fields: readonly string[],
    id: string,
  ) {
    const files = await this.sharedFiles(principal, record, fields);
    if (!files.some((file) => file.id === id)) {
      throw new NotFoundException(`Attachment ${id} not found.`);
    }
    return this.download(principal, id);
  }

  /** An attachment of a record the principal may read, or a 404 (the acknowledgments use it too). */
  async findReadable(principal: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, id));
    if (!row) {
      throw new NotFoundException(`Attachment ${id} not found.`);
    }
    try {
      // A generated file showing fields this principal may not read is
      // theirs to see no more than those fields: 404, as for the record.
      await this.assertCanRead(principal, row, row.fields);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(`Attachment ${id} not found.`);
      }
      throw error;
    }
    return row;
  }
}

/** An attachment as the API shows it: without its storage key. */
export const view = ({
  key: _key,
  fields: _fields,
  renditions,
  ...row
}: Attachment): AttachmentView => ({
  ...row,
  renditions: publicRenditions(renditions),
  versionedAt: row.versionedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const details = (row: Attachment) => ({
  subject: row.subject,
  recordId: row.recordId,
  name: row.name,
  size: row.size,
  contentType: row.contentType,
});

/** The last segment of a client's file name, without control characters, at most 255 characters. */
export function fileName(original: string | undefined) {
  const name = (original ?? '')
    .split(/[/\\]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F"]/g, '')
    .trim()
    .slice(0, 255);
  return name || 'file';
}

/** The download name of a rendition: `photo.jpg`'s thumb is `photo.thumb.webp`. */
function renditionName(name: string, rendition: RenditionName) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${rendition}.webp`;
}
