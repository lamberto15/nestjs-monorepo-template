import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/** What a custom field holds. Values are stored as JSON on the record. */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'boolean',
  'date',
  'select',
  'multiSelect',
  'email',
  'url',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** A choice of a `select` or `multiSelect` field: `value` is stored, `label` shown. */
export interface CustomFieldOption {
  value: string;
  label: string;
}

/**
 * Optional limits of a field, by type:
 * - number: `min` / `max` (the value);
 * - multiSelect: `min` / `max` (how many choices);
 * - text, longText, email, url: `minLength` / `maxLength`, `pattern` (a regular expression, whole value).
 */
export interface CustomFieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** A field as validation and the list helper need it (a row of custom_field_definitions). */
export type CustomFieldDefinition = {
  id: string;
  subject: string;
  key: string;
  label: string;
  description: string | null;
  type: CustomFieldType;
  options: CustomFieldOption[] | null;
  required: boolean;
  defaultValue: unknown;
  validation: CustomFieldValidation | null;
  position: number;
  filterable: boolean;
  sortable: boolean;
  active: boolean;
};

/**
 * A subject (a permission subject, `Note`) whose records take custom fields,
 * and where their values live: a `jsonb not null default '{}'` column of its
 * own table, with a GIN index.
 *
 * ```ts
 * // features/invoices/invoice.resource.ts
 * export const NOTE_CUSTOM_FIELDS = defineCustomFields({ subject: 'Note', table: notes, column: notes.custom });
 * // app.module.ts
 * PlatformModule.forRoot({ …, customFields: [NOTE_CUSTOM_FIELDS] })
 * ```
 *
 * The platform reads the table only to answer "does any record hold a
 * value of this field?" before a field's type or options change.
 */
export interface CustomFieldsDeclaration {
  subject: string;
  table: PgTable;
  column: AnyPgColumn;
}

export const defineCustomFields = <T extends CustomFieldsDeclaration>(
  declaration: T,
) => declaration;
