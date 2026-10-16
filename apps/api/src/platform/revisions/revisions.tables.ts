import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * Each saved state of a record of any feature (the record by its
 * permission subject and id), numbered 1, 2, 3… per record: the fields a
 * person may change (`snapshot`) after each change, and what changed
 * (`changes`, as the audit log's diff). Restoring one is a change like any
 * other: a new revision, marked `restoredFrom`.
 */
export const revisions = pgTable(
  'revisions',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** 1 for the record's first state, then one more per change. */
    number: integer('number').notNull(),
    /** The record's changeable fields (custom values included) after the change. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    /** The fields that changed, from → to (`custom.<key>` per custom value); null for the first. */
    changes:
      jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>(),
    /** The revision this one restored, when it was a restore. */
    restoredFrom: integer('restored_from'),
    /** `user:<id>` or `client:<id>`; `anonymized` once the account is deleted; `unknown` for a state from before revisions were kept. */
    changedBy: text('changed_by').notNull(),
    changedAt: at('changed_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    // The invariant: one revision per number of a record.
    uniqueIndex('revisions_record_number_uq').on(
      table.tenantId,
      table.subject,
      table.recordId,
      table.number,
    ),
    // A record's revisions, newest first (and the next number).
    index('revisions_record_newest_idx').on(
      table.subject,
      table.recordId,
      table.number.desc(),
    ),
    index('revisions_changed_by_idx').on(table.changedBy),
    index('revisions_changed_at_idx').on(table.changedAt),
    ...tenantTable('revisions', table),
  ],
).enableRLS();
