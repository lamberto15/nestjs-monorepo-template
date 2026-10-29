import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import type { FormDefinition, FormFieldType } from './form-schema.js';

/** `active`: takes submissions once published; `archived`: takes none, its submissions stay. */
export const FORM_STATUSES = ['active', 'archived'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

/**
 * A tenant's runtime forms (docs/forms.md): the definition being edited
 * (`draft`, saved with the `revision` it was edited from) and the number
 * of the version submitters fill in now (`published_version`). Publishing
 * copies the draft into `form_versions`, never edited again.
 */
export const forms = pgTable(
  'forms',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Unique in the tenant: `incident-report`. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<FormStatus>().notNull().default('active'),
    draft: jsonb('draft').$type<FormDefinition>().notNull(),
    /** Raised by every saved draft: what a draft save or a publication names to be conflict-safe. */
    revision: integer('revision').notNull().default(1),
    /** The version submitters fill in; null until the first publication. */
    publishedVersion: integer('published_version'),
    /** The draft revision that version was published from: the draft has changes while it differs. */
    publishedRevision: integer('published_revision'),
    /** Every key any published version had, with its type: a key's type never changes. */
    keyTypes: jsonb('key_types')
      .$type<Record<string, FormFieldType>>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (table) => [
    unique('forms_slug_key').on(table.tenantId, table.slug),
    ...tenantTable('forms', table, { referenced: true }),
  ],
).enableRLS();

export type FormRow = typeof forms.$inferSelect;

/** Published versions: immutable snapshots, 1, 2, 3… per form. */
export const formVersions = pgTable(
  'form_versions',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    formId: uuid('form_id').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<FormDefinition>().notNull(),
    publishedAt: at('published_at').notNull().defaultNow(),
  },
  (table) => [
    unique('form_versions_form_version_key').on(table.formId, table.version),
    ...tenantTable('form_versions', table, { referenced: true }),
    // Cascade, so the tenant's deletion goes through; the service deletes
    // only forms never published (409 form_published): none has versions.
    tenantReference(
      'form_versions_form_fk',
      [table.tenantId, table.formId],
      [forms.tenantId, forms.id],
      'cascade',
    ),
  ],
).enableRLS();

export type FormVersionRow = typeof formVersions.$inferSelect;

/**
 * Answers to a published version, as the server validated them. The
 * version is the one they were checked against, for good: a later version
 * never reinterprets them.
 */
export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    formId: uuid('form_id').notNull(),
    versionId: uuid('version_id').notNull(),
    /** Who submitted: `user:<id>` or `client:<id>`. */
    submittedBy: text('submitted_by').notNull(),
    /** `submitted`, the only one yet (a review status may follow). */
    status: text('status').$type<'submitted'>().notNull().default('submitted'),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    ...timestamps(),
  },
  (table) => [
    index('form_submissions_form_idx').on(table.formId, table.id),
    index('form_submissions_submitted_by_idx').on(
      table.submittedBy,
      table.formId,
    ),
    index('form_submissions_version_idx').on(table.versionId),
    ...tenantTable('form_submissions', table),
    tenantReference(
      'form_submissions_form_fk',
      [table.tenantId, table.formId],
      [forms.tenantId, forms.id],
      'cascade',
    ),
    tenantReference(
      'form_submissions_version_fk',
      [table.tenantId, table.versionId],
      [formVersions.tenantId, formVersions.id],
      'cascade',
    ),
  ],
).enableRLS();

export type FormSubmissionRow = typeof formSubmissions.$inferSelect;
