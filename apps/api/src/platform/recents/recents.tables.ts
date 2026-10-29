import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * The records a person opened lately, newest first: a bounded list of their
 * own (docs/recents.md). Only a pointer (the record's subject and id) and the
 * title it showed, never a field's content; the list checks the person still
 * sees the record before it shows the title.
 */
export const recentRecords = pgTable(
  'recent_records',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Whose it is: `user:<id>` or `client:<id>`. */
    owner: text('owner').notNull(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: text('record_id').notNull(),
    /** The name shown in the list, as it was when opened. */
    label: text('label').notNull(),
    viewedAt: at('viewed_at').notNull().defaultNow(),
  },
  (table) => [
    // Opening the same record again moves it to the top, not twice into the list.
    uniqueIndex('recent_records_owner_record_idx').on(
      table.tenantId,
      table.owner,
      table.subject,
      table.recordId,
    ),
    // One owner's list, newest first (GET /recents), and the bound on write.
    index('recent_records_owner_viewed_at_idx').on(table.owner, table.viewedAt),
    // The nightly sweep by age.
    index('recent_records_viewed_at_idx').on(table.viewedAt),
    ...tenantTable('recent_records', table),
  ],
).enableRLS();
