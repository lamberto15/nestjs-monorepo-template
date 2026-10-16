import { bigint, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';

/**
 * Files attached to records: a record (its permission subject and id), the
 * file on the private disk (`key`), and what it is. The bytes are on the
 * disk, never in the database; `contentType` was detected from them.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** Where the file is on the private disk (StorageDisk). */
    key: text('key').notNull(),
    /** The file name the client gave, shown and used for downloads. */
    name: text('name').notNull(),
    /** Bytes (ATTACHMENT_MAX_MB may exceed what an int4 counts). */
    size: bigint('size', { mode: 'number' }).notNull(),
    /** Detected from the bytes, not the client's claim. */
    contentType: text('content_type').notNull(),
    /** `user:<id>` or `client:<id>`; `anonymized` after the uploader's account was deleted. */
    uploadedBy: text('uploaded_by').notNull(),
    ...timestamps(),
  },
  (table) => [
    index('attachments_record_idx').on(table.subject, table.recordId),
    index('attachments_uploaded_by_idx').on(table.uploadedBy),
  ],
);

export type Attachment = typeof attachments.$inferSelect;
