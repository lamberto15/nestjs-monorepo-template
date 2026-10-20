import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type { FlagRule } from './setting-rules.js';
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
    /** The team's id, the principal's key, or '' for the tenant scope. */
    scopeId: text('scope_id').notNull().default(''),
    /** The value (checked by the declaration's schema); null: only `rollout` applies (a flag). */
    value: jsonb('value'),
    /** A flag's rollout percentage (0–100), tenant scope only. */
    rollout: integer('rollout'),
    /** A flag's targeting rules, first match wins, before the value and the rollout. */
    rules: jsonb('rules').$type<FlagRule[]>().notNull().default([]),
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

/**
 * What the deployment's operators set for every tenant
 * (`PUT /settings/{key}/platform`): one row per setting, global (no
 * tenant). Below each tenant's own values (the runtime default), or above
 * them all when `enforced` (a kill switch).
 */
export const platformSettingValues = pgTable('platform_setting_values', {
  id: uuidPk(),
  /** A declared key: `notes.richText`. One row each. */
  key: text('key').notNull().unique(),
  /** The value (checked by the declaration's schema); null: only `rollout` applies (a flag). */
  value: jsonb('value'),
  /** Beats every tenant's, team's and principal's value (with a value only). */
  enforced: boolean('enforced').notNull().default(false),
  /** A flag's rollout percentage (0–100) in every tenant, when no value is set. */
  rollout: integer('rollout'),
  /** A flag's targeting rules, first match wins, before the value and the rollout. */
  rules: jsonb('rules').$type<FlagRule[]>().notNull().default([]),
  /** Who set it: an operator's principal key. */
  updatedBy: text('updated_by').notNull(),
  ...timestamps(),
});
