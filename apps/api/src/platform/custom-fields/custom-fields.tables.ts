import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type {
  CustomFieldOption,
  CustomFieldType,
  CustomFieldValidation,
} from './custom-field.types.js';

/**
 * The fields administrators added to a subject at runtime (`Note`). Their
 * values live on the subject's own table, in a JSONB column (`notes.custom`),
 * keyed by `key`: adding a field needs no migration. A field is never
 * deleted, only deactivated, so its key can't be reused for another type
 * while old values hold it.
 */
export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The permission subject the field belongs to: `Note`. */
    subject: text('subject').notNull(),
    /** The JSON key of the value (a slug): set once, never changed. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    type: text('type').$type<CustomFieldType>().notNull(),
    /** The choices of `select` and `multiSelect`. */
    options: jsonb('options').$type<CustomFieldOption[]>(),
    /** Required on create (a default fills it when it's left out). */
    required: boolean('required').notNull().default(false),
    /** Filled in on create when the value is left out. */
    defaultValue: jsonb('default_value'),
    validation: jsonb('validation').$type<CustomFieldValidation>(),
    /** The order fields are shown in (forms, tables, exports). */
    position: integer('position').notNull().default(0),
    /** May lists filter and sort by it (the list helper offers only these). */
    filterable: boolean('filterable').notNull().default(false),
    sortable: boolean('sortable').notNull().default(false),
    /** Inactive: not accepted on writes, not exported; stored values are kept. */
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('custom_field_definitions_subject_key_idx').on(
      table.tenantId,
      table.subject,
      table.key,
    ),
    index('custom_field_definitions_subject_position_idx').on(
      table.subject,
      table.position,
    ),
    ...tenantTable('custom_field_definitions', table),
  ],
).enableRLS();
