import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { attachments } from '../attachments/attachments.tables.js';

export const DOCUMENT_STATUSES = [
  'queued',
  'rendering',
  'completed',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * Documents asked for (a PDF of a note): the request, then its job's
 * state, then the issued file, an attachment of the record, linked in the
 * transaction that completes the job. Issued documents never change:
 * asking again issues a new one.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuidPk(),
    /** The DocumentSource that renders it: `note`. */
    source: text('source').notNull(),
    /** The record's permission subject (`Note`) and id: whose attachment it becomes. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The language it is written in (the request's) and the time zone of its dates. */
    locale: text('locale').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status').$type<DocumentStatus>().notNull(),
    /** `user:<id>` or `client:<id>`; `anonymized` after their account was deleted. */
    requestedBy: text('requested_by').notNull(),
    /** The issued PDF; the document goes with it (the sweep of a record deleted for good). */
    attachmentId: uuid('attachment_id').references(() => attachments.id, {
      onDelete: 'cascade',
    }),
    /**
     * The record's fields the PDF shows (`title`, `body`…): whoever reads it,
     * or its attachment, must be allowed every one of them now.
     */
    fields: text('fields').array().notNull().default([]),
    /**
     * The render that holds the document (a new token per run): only it may
     * complete it, so a run started twice (a stalled job) issues one PDF.
     */
    runToken: uuid('run_token'),
    /** Why it failed, written for people. */
    error: text('error'),
    issuedAt: at('issued_at'),
    ...timestamps(),
  },
  (table) => [
    index('documents_record_idx').on(table.subject, table.recordId),
    index('documents_requested_by_idx').on(table.requestedBy),
    index('documents_attachment_idx').on(table.attachmentId),
    // One document at a time per record, requester and language.
    uniqueIndex('documents_pending_idx')
      .on(table.source, table.recordId, table.requestedBy, table.locale)
      .where(sql`${table.status} in ('queued', 'rendering')`),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
