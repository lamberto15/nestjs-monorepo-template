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
    "Parts between dots: text (`INV-`), date parts `YYYY`, `YY`, `MM`, `DD`, `JJJ` (day of the year), `WW` (ISO week), in the app time zone; variables (`FY`, `ABBR`: GET /v1/naming-series/variables); the record's own fields in braces (`{customer}`: GET /v1/naming-series/subjects); and one counter of `#` (its length the zero-padding). The counter restarts whenever what the pattern prints around it changes: each year with `YYYY`, each month with `MM`, each value of a field in it.",
  )
  .meta({ example: 'INV-.YYYY.-.MM.-.#####' });

/** A field's name in a subject's create body. */
const fieldName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { message: 'A field name' })
  .max(100);

/** A condition a record's create body must meet for a series to number it. */
export const namingConditionSchema = z
  .object({
    field: fieldName.meta({ example: 'region' }),
    op: z
      .enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])
      .describe(
        'Compared as numbers for number fields, as ISO dates for date fields, else as text.',
      ),
    value: z
      .union([z.string().max(200), z.number(), z.boolean()])
      .meta({ example: 'EU' }),
  })
  .meta({ id: 'NamingCondition' });

const conditions = z
  .array(namingConditionSchema)
  .max(10)
  .describe(
    'All must hold for a record whose body names no series to take this one (Frappe\'s Document Naming Rule); the first by priority wins, else the default series.',
  );

const priority = z
  .number()
  .int()
  .min(-1000)
  .max(1000)
  .describe('Higher first, among the series whose conditions hold.');

const dateField = fieldName
  .describe(
    "A date field of the record its date parts and FY are taken from (`invoiceDate`); the moment it is created when null, or when the record has none.",
  )
  .meta({ example: 'invoiceDate' });

/** Values of a record's fields, to see what a pattern prints for it (`{ customer: 'ACME' }`). */
const sampleValues = z
  .record(fieldName, z.union([z.string().max(200), z.number(), z.boolean()]))
  .describe(
    "A record's field values, as its create body takes them: the counter of the number such a record gets. Fields left out print as `{field}`.",
  );

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
      .describe(
        "What a new record takes when its body names no series and no series' conditions hold for it.",
      ),
    dateField: z.string().nullable().meta({ example: 'invoiceDate' }),
    conditions: z.array(namingConditionSchema),
    priority: z.int(),
    example: z
      .string()
      .describe(
        'The number it gives next, if taken now; the fields it prints show as `{field}`.',
      )
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
    fields: z
      .array(
        z.object({
          name: z.string().meta({ example: 'title' }),
          kind: z.enum(['text', 'number', 'date', 'datetime', 'boolean']),
        }),
      )
      .describe(
        'The fields a pattern may print (`{title}`; not `boolean` ones), a series take its date from (`date`, `datetime`) or its conditions test.',
      ),
  })
  .meta({ id: 'NumberedSubject' });

/** A variable patterns may print (`.FY.`, `{FY}`). */
export const namingVariableSchema = z
  .object({
    name: z.string().meta({ example: 'FY' }),
    description: z.string(),
  })
  .meta({ id: 'NamingVariable' });

export const namingVariableListSchema = listSchema(namingVariableSchema).meta({
  id: 'NamingVariableList',
});

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
  dateField: dateField.optional(),
  conditions: conditions.optional(),
  priority: priority.optional(),
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
  dateField: dateField.nullable().optional(),
  conditions: conditions.optional(),
  priority: priority.optional(),
});
export type UpdateNamingSeriesDto = z.infer<typeof updateNamingSeriesSchema>;

/** Body of `POST /naming-series/preview`. */
export const previewNamingSeriesSchema = z.object({
  subject: createNamingSeriesSchema.shape.subject,
  pattern,
  dateField: dateField.optional(),
  values: sampleValues.optional(),
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
  values: sampleValues
    .optional()
    .describe(
      "For a pattern printing fields: the field values whose counter is set (`{ customer: 'ACME' }`); each value has its own.",
    ),
});
export type SetNamingCounterDto = z.infer<typeof setNamingCounterSchema>;

/** `namingSeriesId` in a numbered record's create body. */
export const namingSeriesIdSchema = z
  .uuid()
  .optional()
  .describe(
    'The naming series that numbers it (GET /v1/naming-series?subject=…); the default series when left out.',
  );
