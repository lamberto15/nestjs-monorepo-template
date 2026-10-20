import { z } from 'zod';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import { MAX_PATTERN_LENGTH, parsePattern } from './naming-pattern.js';

/** `INV-.YYYY.-.#####`: checked by parsePattern (naming-pattern.ts). */
const pattern = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PATTERN_LENGTH)
  .superRefine((value, context) => {
    try {
      parsePattern(value);
    } catch (error) {
      context.addIssue({ code: 'custom', message: (error as Error).message });
    }
  })
  .describe(
    'Parts between dots: text (`INV-`), date parts `YYYY`, `YY`, `MM`, `DD` (in the app time zone), and one counter of `#` (its length the zero-padding). The counter restarts whenever what the pattern prints around it changes: each year with `YYYY`, each month with `MM`.',
  )
  .meta({ example: 'INV-.YYYY.-.MM.-.#####' });

/** A naming series. */
export const namingSeriesSchema = z
  .object({
    id: z.uuid(),
    subject: z
      .string()
      .describe('What it numbers: a permission subject, `Note`.')
      .meta({ example: 'Note' }),
    pattern: z.string().meta({ example: 'INV-.YYYY.-.MM.-.#####' }),
    label: z.string().nullable().meta({ example: 'Invoices' }),
    isDefault: z
      .boolean()
      .describe('What a new record takes when its body names no series.'),
    example: z
      .string()
      .describe('The number it gives next, if taken now.')
      .meta({ example: 'INV-2026-10-00043' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'NamingSeries' });
export type NamingSeriesView = z.infer<typeof namingSeriesSchema>;

/** A page of naming series (`GET /v1/naming-series`). */
export const namingSeriesPageSchema = pageSchema(namingSeriesSchema).meta({
  id: 'NamingSeriesPage',
});

/** A subject whose records take a number, and the format it has in code. */
export const numberedSubjectSchema = z
  .object({
    subject: z.string().meta({ example: 'Note' }),
    declaredPattern: z
      .string()
      .describe('The format in code: used while the subject has no series.')
      .meta({ example: 'NOTE-.YYYY.-.#####' }),
  })
  .meta({ id: 'NumberedSubject' });

export const numberedSubjectListSchema = listSchema(numberedSubjectSchema).meta(
  { id: 'NumberedSubjectList' },
);

/** A counter as it stands now (`GET /naming-series/{id}/counter`, the preview). */
export const namingCounterSchema = z
  .object({
    key: z
      .string()
      .describe(
        'What the pattern prints around its counter now; patterns printing the same share the counter.',
      )
      .meta({ example: 'INV-2026-10-{#}' }),
    current: z
      .number()
      .int()
      .describe('The last value taken (0 when none).')
      .meta({ example: 42 }),
    next: z
      .string()
      .describe('The number the next record gets.')
      .meta({ example: 'INV-2026-10-00043' }),
  })
  .meta({ id: 'NamingCounter' });
export type NamingCounter = z.infer<typeof namingCounterSchema>;

/** Body of `POST /naming-series`. */
export const createNamingSeriesSchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'A subject whose records take a number (GET /v1/naming-series/subjects).',
    )
    .meta({ example: 'Note' }),
  pattern,
  label: z.string().trim().max(100).optional(),
  isDefault: z
    .boolean()
    .optional()
    .describe("The subject's default from now on; its first series is."),
});
export type CreateNamingSeriesDto = z.infer<typeof createNamingSeriesSchema>;

/** Body of `PATCH /naming-series/{id}`: only what is sent changes. */
export const updateNamingSeriesSchema = z.object({
  pattern: pattern.optional(),
  label: z.string().trim().max(100).nullable().optional(),
  isDefault: z
    .literal(true)
    .optional()
    .describe(
      "Makes it the subject's default (another series becomes the default to stop being it).",
    ),
});
export type UpdateNamingSeriesDto = z.infer<typeof updateNamingSeriesSchema>;

/** Query of `GET /naming-series/preview`. */
export const previewNamingSeriesSchema = z.object({
  subject: createNamingSeriesSchema.shape.subject,
  pattern,
});
export type PreviewNamingSeriesDto = z.infer<typeof previewNamingSeriesSchema>;

/** Body of `PUT /naming-series/{id}/counter`. */
export const setNamingCounterSchema = z.object({
  current: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .describe(
      'The last value taken: the next record gets this + 1. Never below the value already taken.',
    )
    .meta({ example: 1000 }),
});
export type SetNamingCounterDto = z.infer<typeof setNamingCounterSchema>;

/** `namingSeriesId` in a numbered record's create body. */
export const namingSeriesIdSchema = z
  .uuid()
  .optional()
  .describe(
    'The naming series that numbers it (GET /v1/naming-series?subject=…); the default series when left out.',
  );
