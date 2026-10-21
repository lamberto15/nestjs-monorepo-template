import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type {
  RenditionStatus,
  StoredRenditions,
} from '../images/renditions.js';

/**
 * Whether the file may be served: `clean` (scanned and found clean, or never
 * scanned because MALWARE_SCANNER is off, the default) or `pending` (stored,
 * its scan queued; downloads are refused until it is clean). An infected
 * file is not a state: the attachment is deleted (docs/attachments.md).
 */
export type AttachmentScanStatus = 'pending' | 'clean';

/**
 * Files attached to records: a record (its permission subject and id), the
 * file on the private disk (`key`), and what it is. The bytes are on the
 * disk, never in the database; `contentType` was detected from them.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** Where the file is on the private disk (StorageDisk): under `tenants/<tenant id>/`. */
    key: text('key').notNull(),
    /** The file name the client gave, shown and used for downloads. */
    name: text('name').notNull(),
    /** Bytes (ATTACHMENT_MAX_MB may exceed what an int4 counts). */
    size: bigint('size', { mode: 'number' }).notNull(),
    /** Detected from the bytes, not the client's claim. */
    contentType: text('content_type').notNull(),
    /** `user:<id>` or `client:<id>`; `anonymized` after the uploader's account was deleted. */
    uploadedBy: text('uploaded_by').notNull(),
    /**
     * An issued document (platform/documents): its file never changes and
     * nobody removes it; it goes only with its record (the nightly sweep).
     */
    locked: boolean('locked').notNull().default(false),
    /**
     * The record's fields a generated file shows (an issued document's):
     * downloading it takes the right to read every one of them, as reading
     * the record would (field-level permissions). Null for uploads.
     */
    fields: text('fields').array(),
    /** `pending` only while a malware scan is queued (MALWARE_SCANNER); `clean` otherwise. */
    scanStatus: text('scan_status')
      .$type<AttachmentScanStatus>()
      .notNull()
      .default('clean'),
    /**
     * Where an uploaded image is in its processing (platform/images,
     * IMAGE_PROCESSING): `pending` from the upload until the queue job has
     * made its renditions and stripped its metadata (`ready`), or could not
     * (`failed`: the file stays as uploaded). Null for what is not processed:
     * other types, and everything stored while processing was off.
     */
    renditionStatus: text('rendition_status').$type<RenditionStatus>(),
    /**
     * The thumbnail and the preview of an image, `thumb` and `preview`: their
     * keys on the private disk (under the tenant's prefix) and sizes. `{}`
     * until `renditionStatus` is `ready`, and for what has none.
     */
    renditions: jsonb('renditions')
      .$type<StoredRenditions>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (table) => [
    index('attachments_record_idx').on(table.subject, table.recordId),
    index('attachments_uploaded_by_idx').on(table.uploadedBy),
    // AttachmentScanRetryJob looks for the uploads stuck pending (a pending file is rare).
    index('attachments_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.scanStatus} = 'pending'`),
    // AttachmentImagesRetryJob looks for the images stuck pending (a pending image is rare).
    index('attachments_rendition_pending_idx')
      .on(table.updatedAt)
      .where(sql`${table.renditionStatus} = 'pending'`),
    ...tenantTable('attachments', table, { referenced: true }),
  ],
).enableRLS();

export type Attachment = typeof attachments.$inferSelect;

/**
 * An upload straight to the object store that has been announced
 * (`POST …/attachments/presign`) and not completed yet
 * (`POST …/attachments/complete`): the server's own record of what it signed.
 * The key is the server's (under the tenant's prefix), and the record, the
 * uploader, the size and the type are what the signed URL is bound to, so the
 * completing request names only the upload's id and is checked against this
 * row, never against the client's word. Gone when the attachment is created;
 * the nightly sweep deletes the object and the row of one that was never
 * completed (docs/attachments.md, "Direct uploads").
 */
export const attachmentUploads = pgTable(
  'attachment_uploads',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** Where the client puts the object, and the attachment's key once completed. */
    key: text('key').notNull(),
    /** The file name the client gave, shown and used for downloads. */
    name: text('name').notNull(),
    /** Bytes the URL is signed for. */
    size: bigint('size', { mode: 'number' }).notNull(),
    /** The `Content-Type` the URL is signed for (the client's declared type, normalized). */
    contentType: text('content_type').notNull(),
    /** `user:<id>` or `client:<id>`: only they may complete it. */
    uploadedBy: text('uploaded_by').notNull(),
    /** When the URL stops working (a PUT already under way may finish after it). */
    expiresAt: at('expires_at').notNull(),
    /**
     * Set while a request completes it: a second, parallel request is refused
     * (409), so two never create two attachments of one object. A claim older
     * than a few minutes is a request that died, and no longer holds it.
     */
    completingAt: at('completing_at'),
    ...timestamps(),
  },
  (table) => [
    // The sweep looks for the uploads past their expiry.
    index('attachment_uploads_expires_idx').on(table.expiresAt),
    // The cap on one uploader's pending uploads.
    index('attachment_uploads_uploaded_by_idx').on(table.uploadedBy),
    ...tenantTable('attachment_uploads', table),
  ],
).enableRLS();

export type AttachmentUpload = typeof attachmentUploads.$inferSelect;
