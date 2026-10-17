import {
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type { SettingScope } from './setting.types.js';

/**
 * The values administrators (and users, for their own preferences) set
 * for the declared settings: one row per setting and scope. Declarations
 * and defaults live in code; a row only holds what differs.
 */
export const settingOverrides = pgTable(
  'setting_overrides',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** A declared key: `notes.publishDelay`. */
    key: text('key').notNull(),
    scope: text('scope').$type<SettingScope>().notNull(),
    /** The org unit's id, the principal's key, or '' for the tenant scope. */
    scopeId: text('scope_id').notNull().default(''),
    /** The value (checked by the declaration's schema); null: only `rollout` applies (a flag). */
    value: jsonb('value'),
    /** A flag's rollout percentage (0–100), tenant scope only. */
    rollout: integer('rollout'),
    /** Who set it: a principal key. */
    updatedBy: text('updated_by').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('setting_overrides_key_scope_idx').on(
      table.tenantId,
      table.key,
      table.scope,
      table.scopeId,
    ),
    ...tenantTable('setting_overrides', table),
  ],
).enableRLS();
