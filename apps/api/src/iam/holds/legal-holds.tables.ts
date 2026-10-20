import { type AnyColumn, sql, type SQL } from 'drizzle-orm';
import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * Legal holds: records that must be kept whatever a retention rule, the
 * recycle bin's purge, a delete or an account deletion would do. A hold
 * names a permission subject (`Note`, or `User` for a person's account) and
 * one record of it, or no record to hold every record of the subject in the
 * tenant. It is active until released; the rows stay as the record of who
 * held what and why (and are audited, as the changes are).
 */
export const legalHolds = pgTable(
  'legal_holds',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The records' permission subject: `Note`; `User` holds a person's account. */
    subject: text('subject').notNull(),
    /** The held record; null holds every record of the subject. */
    recordId: uuid('record_id'),
    /** Why: a case, a request from a court or an authority. */
    reason: text('reason').notNull(),
    /** `user:<id>` or `client:<id>`. */
    placedBy: text('placed_by').notNull(),
    releasedAt: at('released_at'),
    releasedBy: text('released_by'),
    releaseNote: text('release_note'),
    ...timestamps(),
  },
  (table) => [
    index('legal_holds_active_idx')
      .on(table.tenantId, table.subject, table.recordId)
      .where(sql`released_at is null`),
    index('legal_holds_created_at_idx').on(table.tenantId, table.createdAt),
    ...tenantTable('legal_holds', table),
  ],
).enableRLS();

export type LegalHoldRow = typeof legalHolds.$inferSelect;

/**
 * The condition "not under an active hold" for the records of `subject`
 * whose id column is `id`, as a correlated NOT EXISTS (the tenant's rows
 * only: row-level security). For a job's delete or update, so a held record
 * is never selected.
 */
export const notHeld = (subject: string, id: AnyColumn): SQL =>
  sql`not exists (select 1 from ${legalHolds} where ${legalHolds.subject} = ${subject} and ${legalHolds.releasedAt} is null and (${legalHolds.recordId} is null or ${legalHolds.recordId} = ${id}))`;
