import { z } from 'zod';
import { formDefinitionSchema } from './form-schema.js';
import { FORM_STATUSES } from './forms.tables.js';

const slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Lowercase letters, digits and single dashes.',
  })
  .meta({ example: 'incident-report' });
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .meta({ example: 'Incident report' });
const description = z.string().trim().max(2_000);
const revision = z
  .int()
  .min(1)
  .describe(
    "The form's `revision` you edited: refused (409 form_conflict) if it changed since.",
  );

/** A form, as lists and `GET /forms/{id}` show it (no definition). */
export const formSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(FORM_STATUSES),
  revision: z.int(),
  publishedVersion: z
    .int()
    .nullable()
    .describe('The version submitters fill in; null until published.'),
  hasDraftChanges: z
    .boolean()
    .optional()
    .describe('Editors only: the draft differs from the published version.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** `GET /forms/{id}/draft`: what editors change. */
export const formDraftSchema = z.object({
  formId: z.uuid(),
  revision: z.int(),
  definition: formDefinitionSchema,
});

/** A published version: its definition, never changed. */
export const formVersionSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  version: z.int(),
  definition: formDefinitionSchema,
  publishedAt: z.iso.datetime(),
});

/** A version in a list: no definition. */
export const formVersionSummarySchema = formVersionSchema
  .omit({ definition: true })
  .extend({ fieldCount: z.int() });

/** `GET /forms/{id}/published`: what a renderer needs to show and submit it. */
export const publishedFormSchema = z.object({
  formId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  versionId: z.uuid().describe('Send it back with the answers.'),
  version: z.int(),
  definition: formDefinitionSchema,
  publishedAt: z.iso.datetime(),
});

export const createFormSchema = z
  .object({
    slug,
    name,
    description: description.optional(),
    definition: formDefinitionSchema
      .optional()
      .describe('The first draft; default: no sections.'),
  })
  .strict();
export type CreateFormDto = z.infer<typeof createFormSchema>;

export const updateFormSchema = z
  .object({
    slug: slug.optional(),
    name: name.optional(),
    description: description.nullable().optional(),
  })
  .strict();
export type UpdateFormDto = z.infer<typeof updateFormSchema>;

export const saveDraftSchema = z
  .object({ revision, definition: formDefinitionSchema })
  .strict();
export type SaveDraftDto = z.infer<typeof saveDraftSchema>;

export const publishFormSchema = z.object({ revision }).strict();
export type PublishFormDto = z.infer<typeof publishFormSchema>;

export const submitFormSchema = z
  .object({
    versionId: z
      .uuid()
      .describe(
        'The published version the answers were given to (`GET /forms/{id}/published`): refused (409 form_version_outdated) once another is published.',
      ),
    answers: z
      .record(z.string().max(200), z.unknown())
      .describe(
        "Answers by field key, checked on the server against that version's definition.",
      )
      .meta({ example: { full_name: 'Ada', topic: 'billing' } }),
  })
  .strict();
export type SubmitFormDto = z.infer<typeof submitFormSchema>;

export const formSubmissionSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  versionId: z.uuid(),
  version: z
    .int()
    .describe('Read its definition at GET /forms/{id}/versions/{version}.'),
  submittedBy: z.string().describe('`user:<id>` or `client:<id>`.'),
  status: z.enum(['submitted']),
  answers: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
