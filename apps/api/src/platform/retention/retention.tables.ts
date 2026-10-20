import {
  index,
  integer,
  boolean,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * A tenant's choice for a declared retention rule (`RetentionRegistry`):
 * after how many days its records are purged or anonymised, and whether the
 * rule runs at all. A declared rule does nothing in a tenant until the
 * tenant has a row here with `enabled`.
 */
export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The declared rule's name: `note`. */
    rule: text('rule').notNull(),
    /** Records older than this are purged or anonymised. */
    days: integer('days').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** The last time the scheduled job found this rule due. */
    lastRunAt: at('last_run_at'),
    /** Records the last run purged or anonymised. */
    lastCount: integer('last_count'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('retention_policies_rule_idx').on(table.tenantId, table.rule),
    index('retention_policies_enabled_idx').on(table.tenantId, table.enabled),
    ...tenantTable('retention_policies', table),
  ],
).enableRLS();

export type RetentionPolicyRow = typeof retentionPolicies.$inferSelect;
