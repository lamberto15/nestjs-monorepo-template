import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { organizationalUnits } from '../../iam/iam.tables.js';

/** Who sees a record template: its owner alone, the current members of a unit, or the whole tenant. */
export const TEMPLATE_VISIBILITIES = ['private', 'unit', 'tenant'] as const;
export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];

/**
 * Record templates: values to prefill a new record of a subject
 * (`POST /v1/<path>`), kept under a name. A template only holds values of
 * the subject's create schema; it is previewed (`GET /v1/templates/{id}/preview`,
 * checked again against the schema and the caller's permissions as they
 * are now) and the client then creates the record through the subject's
 * own route, which validates and authorizes it as any create.
 */
export const recordTemplates = pgTable(
  'record_templates',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    name: text('name').notNull(),
    visibility: text('visibility').$type<TemplateVisibility>().notNull(),
    /** Whose it is: `user:<id>` or `client:<id>`; `anonymous` once its owner's account is gone. */
    owner: text('owner').notNull(),
    /** The organizational unit a `unit` template is shared with; null otherwise. */
    unitId: uuid('unit_id'),
    /** What the name is unique within (case-insensitively, per subject): the owner's key, `unit:<id>`, or `tenant`. */
    scope: text('scope').notNull(),
    /** The create body's values to prefill, as the create route takes them. */
    values: jsonb('values')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('record_templates_name_idx').on(
      table.tenantId,
      table.subject,
      table.scope,
      sql`lower(${table.name})`,
    ),
    index('record_templates_owner_idx').on(table.owner, table.subject),
    index('record_templates_unit_idx').on(table.unitId),
    check(
      'record_templates_unit_check',
      sql`(${table.visibility} = 'unit') = (${table.unitId} is not null)`,
    ),
    check(
      'record_templates_visibility_check',
      sql`${table.visibility} in ('private', 'unit', 'tenant')`,
    ),
    ...tenantTable('record_templates', table),
    // A unit with templates shared with it can't be deleted (409 `unit_not_empty`).
    tenantReference(
      'record_templates_unit_fk',
      [table.tenantId, table.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
      'restrict',
    ),
  ],
).enableRLS();

export type RecordTemplateRow = typeof recordTemplates.$inferSelect;
