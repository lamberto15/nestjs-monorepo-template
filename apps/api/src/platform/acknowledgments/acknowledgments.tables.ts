import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { attachments } from '../attachments/attachments.tables.js';

/**
 * A request that one person acknowledge one version of a document (an
 * attachment), and the answer. It records that the person confirmed they
 * read that version, when: not a signature. The rows go with the attachment
 * (a removed document has nothing left to acknowledge; the audit log keeps
 * who confirmed what).
 */
export const documentAcknowledgments = pgTable(
  'document_acknowledgments',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    attachmentId: uuid('attachment_id').notNull(),
    /** The document's version (`versionOf()`): 1 until attachments are versioned. */
    version: integer('version').notNull(),
    /** Who is asked: `user:<id>`. */
    recipient: text('recipient').notNull(),
    /** Who asked: `user:<id>` or `client:<id>`. */
    requestedBy: text('requested_by').notNull(),
    dueAt: at('due_at'),
    /** How many reminders were sent, and when the last was. */
    reminders: integer('reminders').notNull().default(0),
    lastRemindedAt: at('last_reminded_at'),
    acknowledgedAt: at('acknowledged_at'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('document_acknowledgments_version_recipient_idx').on(
      table.attachmentId,
      table.version,
      table.recipient,
    ),
    index('document_acknowledgments_recipient_idx').on(
      table.recipient,
      table.acknowledgedAt,
    ),
    ...tenantTable('document_acknowledgments', table),
    tenantReference(
      'document_acknowledgments_attachment_fk',
      [table.tenantId, table.attachmentId],
      [attachments.tenantId, attachments.id],
    ),
  ],
).enableRLS();

export type DocumentAcknowledgment =
  typeof documentAcknowledgments.$inferSelect;
