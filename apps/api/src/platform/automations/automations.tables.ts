import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type {
  AutomationAction,
  AutomationRunAction,
} from './automation.schemas.js';

/**
 * A tenant's automation rules (docs/automations.md): when a record of a
 * subject is created or updated (or one of its fields changes), and it
 * matches the conditions (the subject's list filters), do the actions.
 * Declarative: a closed set of actions, no code. `version` counts the
 * changes of what it does; a change takes effect once it is activated
 * again. It runs as `owner`, the user who activated it.
 */
export const automationRules = pgTable(
  'automation_rules',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    name: text('name').notNull(),
    /** The records' permission subject: `Note`. */
    subject: text('subject').notNull(),
    trigger: text('trigger').$type<'created' | 'updated'>().notNull(),
    /** With `updated`: only when this field changed. */
    field: text('field'),
    /** The subject's list filters, as its list route takes them. */
    filters: jsonb('filters')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    actions: jsonb('actions').$type<AutomationAction[]>().notNull(),
    status: text('status')
      .$type<'draft' | 'active' | 'disabled'>()
      .notNull()
      .default('draft'),
    version: integer('version').notNull().default(1),
    /** `user:<id>` of who activated it: it runs with their permissions, as they are at each run. */
    owner: text('owner'),
    activatedAt: at('activated_at'),
    /** Why it is disabled: `manual`, `owner_inactive`, `run_limit`, `failing`, `subject_gone`. */
    disabledReason: text('disabled_reason'),
    /** Failed runs in a row: at MAX_FAILURES it is disabled. */
    failures: integer('failures').notNull().default(0),
    lastRunAt: at('last_run_at'),
    lastStatus: text('last_status').$type<'succeeded' | 'failed'>(),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('automation_rules', table),
    // What a record's write asks: the active rules of its subject.
    index('automation_rules_active_idx')
      .on(table.tenantId, table.subject)
      .where(sql`status = 'active'`),
  ],
).enableRLS();

export type AutomationRuleRow = typeof automationRules.$inferSelect;

/** What each run of a rule did (or why it failed), newest first. */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    ruleVersion: integer('rule_version').notNull(),
    recordId: uuid('record_id').notNull(),
    status: text('status').$type<'succeeded' | 'failed'>().notNull(),
    actions: jsonb('actions').$type<AutomationRunAction[]>().notNull(),
    error: text('error'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    ...tenantTable('automation_runs', table),
    index('automation_runs_rule_idx').on(table.ruleId, table.id),
  ],
).enableRLS();

export type AutomationRunRow = typeof automationRuns.$inferSelect;
