import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';

/**
 * Comments on records of any feature (the record by its permission subject
 * and id), with the people they mention. Deleted for good, not to a
 * recycle bin; every write is audited (`comment.added`, `-edited`,
 * `-removed`, `-resolved`, `-reopened`). A comment may answer a top-level
 * one (`parentId`, one level of replies); a top-level comment is a thread
 * that can be resolved.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** `user:<id>` or `client:<id>`; `anonymous` once the author's account is deleted. */
    author: text('author').notNull(),
    body: text('body').notNull(),
    /** The principal keys mentioned (`@ada@example.com`, `@user:<id>`) who may read the record. */
    mentions: text('mentions').array().notNull().default([]),
    editedAt: at('edited_at'),
    /** The top-level comment this one answers; null for a top-level comment. Replies go with it. */
    parentId: uuid('parent_id'),
    /** Set on a top-level comment while its thread is resolved. */
    resolvedAt: at('resolved_at'),
    /** Who resolved it: `user:<id>` or `client:<id>`. */
    resolvedBy: text('resolved_by'),
    ...timestamps(),
  },
  (table) => [
    index('comments_record_idx').on(table.subject, table.recordId, table.id),
    index('comments_author_idx').on(table.author),
    // An account's deletion finds the comments mentioning it.
    index('comments_mentions_idx').using('gin', table.mentions),
    index('comments_parent_idx').on(table.parentId),
    ...tenantTable('comments', table, { referenced: true }),
    tenantReference(
      'comments_parent_fk',
      [table.tenantId, table.parentId],
      [table.tenantId, table.id],
    ),
  ],
).enableRLS();
