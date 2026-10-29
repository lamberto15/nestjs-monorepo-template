import { z } from 'zod';
import { MAX_CHOICES } from '../choices/choices.schemas.js';
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

/** `GET /forms/option-sources`: the providers an editor may give a choice field. */
export const formOptionSourcesSchema = z.object({
  items: z.array(
    z.object({
      key: z
        .string()
        .meta({ example: 'organizational-units' })
        .describe("A field's `optionsSource.provider`."),
      label: z.string(),
    }),
  ),
});

/** Query of `GET /forms/{id}/options/{key}`. */
export const formOptionsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_CHOICES).optional(),
  })
  .strict();
export type FormOptionsQuery = z.infer<typeof formOptionsQuerySchema>;

/** A sourced field's choices for the person filling in. */
export const formOptionsSchema = z.object({
  field: z.string(),
  items: z.array(
    z.object({
      value: z
        .string()
        .describe('What the answer holds and the server checks.'),
      label: z
        .string()
        .describe('For display only: never sent back or trusted.'),
    }),
  ),
  hasMore: z
    .boolean()
    .describe('More match: narrow with `q` (an answer holds at most `limit`).'),
});

/** `POST /forms/{id}/public-links`. */
export const createPublicLinkSchema = z
  .object({
    expiresAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'When it stops working: within 365 days; 30 days when left out.',
      ),
    maxSubmissions: z
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe(
        'The most submissions it takes (its quota): 1000 when left out.',
      ),
  })
  .strict();
export type CreatePublicLinkDto = z.infer<typeof createPublicLinkSchema>;

/** A form's public link, as its editors see it (never its token, after it was made). */
export const formPublicLinkSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  createdBy: z.string(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  maxSubmissions: z.int(),
  submissions: z.int(),
  lastSubmittedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

/** The new link: its token and URL, shown this once. */
export const createdPublicLinkSchema = formPublicLinkSchema.extend({
  token: z.string().describe('Shown once: only its hash is kept.'),
  url: z
    .string()
    .describe(
      "The web app's page that opens it: `<WEB_URL>/public-form#<token>`.",
    ),
});

const token = z.string().min(1).max(200).describe("The link's token.");

/** `POST /public/forms/open`: the token in the body, never in a URL. */
export const openPublicFormSchema = z.object({ token }).strict();
export type OpenPublicFormDto = z.infer<typeof openPublicFormSchema>;

/** What a public link opens: the published version, nothing of its tenant. */
export const publicFormSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  versionId: z.uuid().describe('Send it back with the answers.'),
  version: z.int(),
  definition: formDefinitionSchema,
});

/** `POST /public/forms/submit`. */
export const publicSubmitSchema = z
  .object({
    token,
    versionId: z.uuid(),
    answers: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PublicSubmitDto = z.infer<typeof publicSubmitSchema>;

/** A public submission, as its sender sees it: no answers of anyone, its own included. */
export const publicSubmissionSchema = z.object({
  id: z.uuid(),
  version: z.int(),
  createdAt: z.iso.datetime(),
});
