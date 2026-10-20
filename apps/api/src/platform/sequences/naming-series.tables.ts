import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * The number formats a tenant's administrators define for a numbered
 * subject (`INV-.YYYY.-.#####`, naming-pattern.ts), Frappe's naming
 * series: several per subject, one its default. The counters live in
 * `sequences`, keyed by what a pattern prints around its counter.
 */
export const namingSeries = pgTable(
  'naming_series',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** What it numbers: a permission subject, `Note`. */
    subject: text('subject').notNull(),
    pattern: text('pattern').notNull(),
    /** What people pick it by: `Credit notes`. */
    label: text('label'),
    /** The series a new record takes when its body names none. */
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('naming_series_pattern_idx').on(
      table.tenantId,
      table.subject,
      table.pattern,
    ),
    // One default per subject.
    uniqueIndex('naming_series_default_idx')
      .on(table.tenantId, table.subject)
      .where(sql`${table.isDefault}`),
    ...tenantTable('naming_series', table),
  ],
).enableRLS();
