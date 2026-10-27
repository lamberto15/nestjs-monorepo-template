import { bigint, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * Counters for human-readable numbers (`INV-2026-00042`): one row per
 * sequence and scope (a unit, a year), its last value. A row is locked
 * for the transaction that takes a number, so numbers are gapless:
 * a rollback takes none. Per tenant: each numbers its own series.
 */
export const sequences = pgTable(
  'sequences',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** What is numbered: `invoice`, `note`. */
    name: text('name').notNull(),
    /** Numbered apart: per unit, per year, or '' for one series. */
    scope: text('scope').notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('sequences_name_scope_idx').on(
      table.tenantId,
      table.name,
      table.scope,
    ),
    ...tenantTable('sequences', table),
  ],
).enableRLS();
