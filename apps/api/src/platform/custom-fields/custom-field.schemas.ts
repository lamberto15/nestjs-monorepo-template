import { z } from 'zod';
import { patternProblem } from './custom-field.pattern.js';
import { CUSTOM_FIELD_TYPES } from './custom-field.types.js';
import { CUSTOM_KEY_PATTERN } from './custom-field.values.js';

/**
 * The definitions API's bodies and responses. What depends on the type
 * (options, validation keys, the default) is checked by the service
 * (`definitionIssues`), on the definition as it would be saved.
 */

const optionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
});

const validationSchema = z
  .object({
    min: z
      .number()
      .optional()
      .describe('number: lowest value; multiSelect: fewest choices.'),
    max: z
      .number()
      .optional()
      .describe('number: highest value; multiSelect: most choices.'),
    minLength: z.int().min(0).optional(),
    maxLength: z.int().min(1).optional(),
    pattern: z
      .string()
      .min(1)
      .max(200)
      // The compile that runs on the values (RE2, custom-field.pattern.ts):
      // what it refuses here, it would refuse there.
      .superRefine((pattern, ctx) => {
        const problem = patternProblem(pattern);
        if (problem !== null) {
          ctx.addIssue({ code: 'custom', message: problem });
        }
      })
      .optional()
      .describe(
        'A regular expression the whole value must match (text types), in RE2 syntax: no lookaround, no backreferences.',
      ),
  })
  .strict();

export const customFieldListQuerySchema = z
  .object({
    subject: z.string().min(1).max(100).meta({ example: 'Note' }),
    includeInactive: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    include: z
      .enum(['counts'])
      .optional()
      .describe(
        'counts: add valueCount and deletedValueCount to each field (how many records hold a value; needs Access.manageCustomFields).',
      ),
    lang: z.string().max(35).optional(),
  })
  .strict();

export const customFieldSubjectsQuerySchema = z
  .object({ lang: z.string().max(35).optional() })
  .strict();

export const createCustomFieldSchema = z
  .object({
    subject: z.string().min(1).max(100).meta({ example: 'Note' }),
    key: z
      .string()
      .regex(CUSTOM_KEY_PATTERN, {
        message:
          'A key starts with a lowercase letter, then lowercase letters, digits or _ (50 at most).',
      })
      .meta({ example: 'region' })
      .describe('The JSON key of the value; never changes.'),
    label: z.string().trim().min(1).max(120).meta({ example: 'Region' }),
    description: z.string().max(500).nullable().optional(),
    type: z.enum(CUSTOM_FIELD_TYPES).meta({ example: 'select' }),
    options: z
      .array(optionSchema)
      .max(200)
      .optional()
      .meta({
        example: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'Americas' },
        ],
      })
      .describe('The choices of select and multiSelect.'),
    required: z.boolean().optional(),
    default: z
      .unknown()
      .optional()
      .describe('Filled in on create when the value is left out.'),
    validation: validationSchema.optional(),
    position: z.int().min(0).optional().describe('Default: after the others.'),
    filterable: z.boolean().optional(),
    sortable: z.boolean().optional(),
  })
  .strict();
export type CreateCustomFieldDto = z.infer<typeof createCustomFieldSchema>;

export const updateCustomFieldSchema = createCustomFieldSchema
  .omit({ subject: true, key: true, position: true })
  .partial()
  .extend({
    options: z.array(optionSchema).max(200).nullable().optional(),
    validation: validationSchema.nullable().optional(),
    default: z.unknown().optional().describe('null: no default.'),
    active: z
      .boolean()
      .optional()
      .describe('false deactivates (values kept), true brings it back.'),
  })
  .strict();
export type UpdateCustomFieldDto = z.infer<typeof updateCustomFieldSchema>;

export const reorderCustomFieldsSchema = z
  .object({
    subject: z.string().min(1).max(100),
    ids: z
      .array(z.uuid())
      .min(1)
      .max(500)
      .describe('These fields first, in this order; the others follow.'),
  })
  .strict();

export const customFieldSchema = z.object({
  id: z.uuid(),
  subject: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(optionSchema).nullable(),
  required: z.boolean(),
  default: z.unknown().nullable(),
  validation: validationSchema.nullable(),
  position: z.int(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  active: z.boolean(),
  valueCount: z
    .int()
    .optional()
    .describe(
      'Only with ?include=counts: the records of your tenant holding a value for this field (those in the recycle bin apart: deletedValueCount). Values of a deactivated field count too: they are kept.',
    ),
  deletedValueCount: z
    .int()
    .optional()
    .describe(
      'Only with ?include=counts: the same, among the records in the recycle bin (0 for a subject without one). They block a type change or a removed choice like any other.',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const customFieldSubjectSchema = z.object({
  subject: z.string().meta({ example: 'Note' }),
  label: z
    .object({
      singular: z.string().meta({ example: 'Note' }),
      plural: z.string().meta({ example: 'Notes' }),
    })
    .describe(
      "How the subject is named, in the response's language: one record and several.",
    ),
});

/** `custom` on a feature's bodies: checked against the subject's fields by the service. */
export const customValuesInputSchema = z
  .record(z.string().max(64), z.unknown())
  .meta({ example: { region: 'eu' } })
  .describe(
    'Custom field values by key (GET /custom-fields?subject=…). On an update, only the keys sent change; null removes one.',
  );

/** `custom` in a feature's responses. */
export const customValuesSchema = z
  .record(z.string(), z.unknown())
  .describe('Custom field values by key.');
