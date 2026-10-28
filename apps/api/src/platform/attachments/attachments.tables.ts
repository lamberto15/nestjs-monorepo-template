import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
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
    /**
     * The number of the file the row holds now (1, then one more with every
     * replacement or restoration); the earlier ones are `attachment_versions`.
     */
    version: integer('version').notNull().default(1),
    /** The note the uploader gave this version (a replacement's), if any. */
    revisionNote: text('revision_note'),
    /** When the current version was put in place: the upload, or the last replacement or restoration. */
    versionedAt: at('versioned_at').notNull().defaultNow(),
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
 * row, never against the client's word. The object at `key` is where the
 * client PUT: the attachment is a copy of it on a key of the server's own
 * (the signed URL keeps working until it expires, and must not reach the
 * file that was checked). The row stays, `completedAt` set, until the nightly
 * sweep removes it with whatever was PUT to `key` meanwhile; the sweep also
 * deletes the object and the row of one that was never completed
 * (docs/attachments.md, "Direct uploads").
 */
export const attachmentUploads = pgTable(
  'attachment_uploads',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** Where the client puts the object: never the attachment's key, which is a copy made on completion. */
    key: text('key').notNull(),
    /** The file name the client gave, shown and used for downloads. */
    name: text('name').notNull(),
    /** Bytes the URL is signed for. */
    size: bigint('size', { mode: 'number' }).notNull(),
    /** The `Content-Type` the URL is signed for (the client's declared type, normalized). */
    contentType: text('content_type').notNull(),
    /** `user:<id>` or `client:<id>`: only they may complete it. */
    uploadedBy: text('uploaded_by').notNull(),
    /**
     * A resumable session (`POST …/attachments/sessions`) rather than a signed
     * URL: the client sends the file in chunks through the API, each at the
     * offset `received` says, kept as parts under `<key>.parts/` until the
     * completion assembles them. Works on every storage driver.
     */
    resumable: boolean('resumable').notNull().default(false),
    /** Bytes of a resumable session stored so far (the next chunk's offset). */
    received: bigint('received', { mode: 'number' }).notNull().default(0),
    /** When the URL, or the session, stops working (a PUT already under way may finish after it). */
    expiresAt: at('expires_at').notNull(),
    /**
     * Set while a request completes it: a second, parallel request is refused
     * (409), so two never create two attachments of one object. A claim older
     * than a few minutes is a request that died, and no longer holds it.
     */
    completingAt: at('completing_at'),
    /** Set once the attachment exists: the upload can't be completed again, and no longer counts as pending. */
    completedAt: at('completed_at'),
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

/**
 * The earlier files of an attachment (replaced, or set aside by a
 * restoration): the bytes at `key` stay as they were, clean when they were
 * archived (a file is replaced only once its scan is done), until the
 * attachment goes (removal, the nightly sweep), which deletes them with it.
 * They count in the tenant's `storageBytes`. docs/attachments.md, "Versions".
 */
export const attachmentVersions = pgTable(
  'attachment_versions',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    attachmentId: uuid('attachment_id').notNull(),
    /** The number it had as the attachment's file. */
    version: integer('version').notNull(),
    /** Where the file is on the private disk, under the tenant's prefix. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    /** `user:<id>` or `client:<id>`; `anonymized` after the uploader's account was deleted. */
    uploadedBy: text('uploaded_by').notNull(),
    /** The note it was given. */
    note: text('note'),
    /** When it became the attachment's file. */
    uploadedAt: at('uploaded_at').notNull(),
    /** When it was replaced. */
    replacedAt: at('replaced_at').notNull().defaultNow(),
  },
  (table) => [
    unique('attachment_versions_attachment_version_key').on(
      table.attachmentId,
      table.version,
    ),
    index('attachment_versions_uploaded_by_idx').on(table.uploadedBy),
    ...tenantTable('attachment_versions', table),
    tenantReference(
      'attachment_versions_attachment_fk',
      [table.tenantId, table.attachmentId],
      [attachments.tenantId, attachments.id],
    ),
  ],
).enableRLS();

export type AttachmentVersion = typeof attachmentVersions.$inferSelect;
