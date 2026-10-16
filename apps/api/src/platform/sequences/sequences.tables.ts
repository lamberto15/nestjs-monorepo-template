import { bigint, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';

/**
 * Counters for human-readable numbers (`INV-2026-00042`): one row per
 * sequence and scope (a unit, a year), its last value. A row is locked
 * for the transaction that takes a number, so numbers are gapless:
 * a rollback takes none.
 */
export const sequences = pgTable(
  'sequences',
  {
    id: uuidPk(),
    /** What is numbered: `invoice`, `note`. */
    name: text('name').notNull(),
    /** Numbered apart: per org unit, per year, or '' for one series. */
    scope: text('scope').notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('sequences_name_scope_idx').on(table.name, table.scope),
  ],
);
