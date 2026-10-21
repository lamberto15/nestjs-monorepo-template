import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

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
    ...timestamps(),
  },
  (table) => [
    index('attachments_record_idx').on(table.subject, table.recordId),
    index('attachments_uploaded_by_idx').on(table.uploadedBy),
    // AttachmentScanRetryJob looks for the uploads stuck pending (a pending file is rare).
    index('attachments_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.scanStatus} = 'pending'`),
    ...tenantTable('attachments', table, { referenced: true }),
  ],
).enableRLS();

export type Attachment = typeof attachments.$inferSelect;
