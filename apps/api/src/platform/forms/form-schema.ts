import { z } from 'zod';
import { patternProblem } from '../custom-fields/custom-field.pattern.js';

/**
 * A form's definition: data, never code (docs/forms.md, "The schema"). One
 * canonical descriptor, validated here when a draft is saved and again when
 * it is published; the web renderer and the submissions validator read the
 * same shape. Sections in order, each with its fields in order; every
 * field has a stable `key` (its answer's key), unique in the whole form.
 *
 * Extension points (later issues), all additive so a stored schema stays
 * valid: field `visibleWhen` / `requiredWhen` (declarative conditions),
 * `pages` and a `group` field type (repeatable, one level), `optionsSource`
 * (a server-registered provider) in place of `options`. Until then every
 * object is strict: an unknown property is refused, not stored.
 */

/** The descriptor format; a later format is a new number, read beside this one. */
export const FORM_SCHEMA_FORMAT = 1;

/** The field types a form may have. `radio` is a single choice drawn as radio buttons. */
export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'url',
  'integer',
  'decimal',
  'date',
  'checkbox',
  'select',
  'multiSelect',
  'radio',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** The types whose answer is one of `options` (or several, multiSelect). */
export const CHOICE_TYPES: readonly FormFieldType[] = [
  'select',
  'multiSelect',
  'radio',
];

/** Hard limits of a schema, whatever an administrator asks. */
export const FORM_LIMITS = {
  sections: 50,
  /** In the whole form. */
  fields: 200,
  options: 200,
  /** The schema as JSON, in bytes. */
  bytes: 64 * 1024,
  translations: 10,
};

/** The longest answer of each text type, whatever the field's own `maxLength`. */
export const ANSWER_TEXT_LIMITS: Partial<Record<FormFieldType, number>> = {
  text: 1_000,
  textarea: 10_000,
  email: 254,
  url: 2_048,
};

/** A field's or a section's key: an answer's JSON key, so a strict slug. */
export const FORM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** Something a browser could read as markup: labels are plain text, never HTML. */
const MARKUP = /<\s*[a-zA-Z!/?]/;
/** Control characters but tab and line breaks. */
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');

/** Plain text of at most `max` characters: no markup, no control characters. */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !MARKUP.test(value), {
      message: 'Plain text only: no HTML tags.',
    })
    .refine((value) => !CONTROL.test(value), {
      message: 'No control characters.',
    });

const key = z.string().regex(FORM_KEY_PATTERN, {
  message:
    'A key starts with a lowercase letter, then lowercase letters, digits or _ (50 at most).',
});

/** A locale's code, as LOCALES spells them: `de`, `pt-BR`. */
const locale = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

/** Texts in other languages than the form's own, by locale: what a renderer shows in that language. */
const translations = <T extends z.ZodRawShape>(shape: T) =>
  z
    .record(locale, z.object(shape).partial().strict())
    .refine((value) => Object.keys(value).length <= FORM_LIMITS.translations, {
      message: `At most ${FORM_LIMITS.translations} languages.`,
    })
    .optional();

const optionSchema = z
  .object({
    value: z.string().trim().min(1).max(100).describe('Stored in the answer.'),
    label: plainText(200).pipe(z.string().min(1)),
    translations: translations({ label: plainText(200) }),
  })
  .strict();

/**
 * Optional limits, by type: text types `minLength` / `maxLength` /
 * `pattern` (RE2, the whole answer); integer and decimal `min` / `max`
 * (decimal also `decimals`, the most digits after the point); date
 * `minDate` / `maxDate`; multiSelect `minItems` / `maxItems`.
 */
const validationSchema = z
  .object({
    minLength: z.int().min(0).optional(),
    maxLength: z.int().min(1).optional(),
    pattern: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'A regular expression the whole answer must match, in RE2 syntax: no lookaround, no backreferences.',
      ),
    min: z.number().optional(),
    max: z.number().optional(),
    decimals: z.int().min(0).max(10).optional(),
    minDate: z.iso.date().optional(),
    maxDate: z.iso.date().optional(),
    minItems: z.int().min(0).optional(),
    maxItems: z.int().min(1).optional(),
  })
  .strict();
export type FormFieldValidation = z.infer<typeof validationSchema>;

/** Which `validation` keys each type takes. */
const VALIDATION_KEYS: Record<FormFieldType, (keyof FormFieldValidation)[]> =
  {
    text: ['minLength', 'maxLength', 'pattern'],
    textarea: ['minLength', 'maxLength', 'pattern'],
    email: ['minLength', 'maxLength', 'pattern'],
    url: ['minLength', 'maxLength', 'pattern'],
    integer: ['min', 'max'],
    decimal: ['min', 'max', 'decimals'],
    date: ['minDate', 'maxDate'],
    checkbox: [],
    select: [],
    radio: [],
    multiSelect: ['minItems', 'maxItems'],
  };

export const formFieldSchema = z
  .object({
    key: key.describe(
      "The answer's key: unique in the form, and once published its type never changes.",
    ),
    type: z.enum(FORM_FIELD_TYPES),
    label: plainText(200).pipe(z.string().min(1)),
    help: plainText(1_000).optional(),
    placeholder: plainText(200).optional(),
    required: z
      .boolean()
      .optional()
      .describe('A checkbox that is required must be checked (a consent).'),
    default: z
      .unknown()
      .optional()
      .describe("Used when the answer is left out: of the field's type."),
    options: z
      .array(optionSchema)
      .max(FORM_LIMITS.options)
      .optional()
      .describe('The choices of select, multiSelect and radio.'),
    validation: validationSchema.optional(),
    translations: translations({
      label: plainText(200),
      help: plainText(1_000),
      placeholder: plainText(200),
    }),
  })
  .strict();
export type FormField = z.infer<typeof formFieldSchema>;

export const formSectionSchema = z
  .object({
    key,
    title: plainText(200).optional(),
    description: plainText(2_000).optional(),
    fields: z.array(formFieldSchema).max(FORM_LIMITS.fields),
    translations: translations({
      title: plainText(200),
      description: plainText(2_000),
    }),
  })
  .strict();
export type FormSection = z.infer<typeof formSectionSchema>;

/** A form's definition (a draft, or a published version's snapshot). */
export const formDefinitionSchema = z
  .object({
    format: z
      .literal(FORM_SCHEMA_FORMAT)
      .default(FORM_SCHEMA_FORMAT)
      .describe('The descriptor format: 1.'),
    sections: z.array(formSectionSchema).max(FORM_LIMITS.sections),
  })
  .strict()
  .meta({
    example: {
      format: 1,
      sections: [
        {
          key: 'contact',
          title: 'Contact',
          fields: [
            { key: 'full_name', type: 'text', label: 'Name', required: true },
            {
              key: 'topic',
              type: 'select',
              label: 'Topic',
              options: [
                { value: 'billing', label: 'Billing' },
                { value: 'other', label: 'Something else' },
              ],
            },
          ],
        },
      ],
    },
  });
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

/** A definition with no fields: what a new form starts from. */
export const EMPTY_DEFINITION: FormDefinition = {
  format: FORM_SCHEMA_FORMAT,
  sections: [],
};

/** Every field of a definition, in order. */
export const fieldsOf = (definition: FormDefinition) =>
  definition.sections.flatMap((section) => section.fields);

/** The type of every field by key: what a published version fixes (`keyTypes`). */
export const keyTypesOf = (definition: FormDefinition) =>
  Object.fromEntries(
    fieldsOf(definition).map((field) => [field.key, field.type]),
  ) as Record<string, FormFieldType>;

export interface SchemaIssue {
  /** Dotted, from the definition: `sections.0.fields.2.options.1.value`. */
  path: string;
  message: string;
}

/**
 * What the Zod shape can't say about a definition (empty: valid): unique
 * keys, the limits of the whole form, options and validation keys by type,
 * patterns RE2 runs, defaults of the field's type, and keys whose type an
 * earlier published version fixed (`keyTypes`): a key keeps its meaning,
 * so old answers stay readable; a new meaning takes a new key.
 */
export function definitionIssues(
  definition: FormDefinition,
  keyTypes: Record<string, string> = {},
  valueIssues: (field: FormField, value: unknown) => string | null = () =>
    null,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const bytes = Buffer.byteLength(JSON.stringify(definition));
  if (bytes > FORM_LIMITS.bytes) {
    issues.push({
      path: '',
      message: `The form is ${bytes} bytes as JSON: at most ${FORM_LIMITS.bytes}.`,
    });
  }
  const total = fieldsOf(definition).length;
  if (total > FORM_LIMITS.fields) {
    issues.push({
      path: 'sections',
      message: `At most ${FORM_LIMITS.fields} fields in a form (${total}).`,
    });
  }
  const sectionKeys = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const [s, section] of definition.sections.entries()) {
    const at = `sections.${s}`;
    if (sectionKeys.has(section.key)) {
      issues.push({ path: `${at}.key`, message: 'Section keys must differ.' });
    }
    sectionKeys.add(section.key);
    for (const [f, field] of section.fields.entries()) {
      const path = `${at}.fields.${f}`;
      if (fieldKeys.has(field.key)) {
        issues.push({
          path: `${path}.key`,
          message: 'Field keys must differ in the whole form.',
        });
      }
      fieldKeys.add(field.key);
      const fixed = keyTypes[field.key];
      if (fixed && fixed !== field.type) {
        issues.push({
          path: `${path}.type`,
          message: `A published version has "${field.key}" as ${fixed}: its type can't change. Use a new key.`,
        });
      }
      issues.push(...fieldIssues(field, path, valueIssues));
    }
  }
  return issues;
}

function fieldIssues(
  field: FormField,
  path: string,
  valueIssues: (field: FormField, value: unknown) => string | null,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const options = field.options ?? [];
  if (CHOICE_TYPES.includes(field.type)) {
    if (options.length === 0) {
      issues.push({
        path: `${path}.options`,
        message: 'A choice field needs options.',
      });
    }
    const seen = new Set<string>();
    for (const [index, option] of options.entries()) {
      if (seen.has(option.value)) {
        issues.push({
          path: `${path}.options.${index}.value`,
          message: 'Option values must differ.',
        });
      }
      seen.add(option.value);
    }
  } else if (field.options !== undefined) {
    issues.push({
      path: `${path}.options`,
      message: `A ${field.type} field takes no options.`,
    });
  }
  const rules = field.validation ?? {};
  const allowed = VALIDATION_KEYS[field.type];
  for (const name of Object.keys(rules) as (keyof FormFieldValidation)[]) {
    if (rules[name] !== undefined && !allowed.includes(name)) {
      issues.push({
        path: `${path}.validation.${name}`,
        message: `A ${field.type} field takes no ${name}.`,
      });
    }
  }
  const below = (low?: number | string, high?: number | string) =>
    low !== undefined && high !== undefined && low > high;
  if (below(rules.min, rules.max)) {
    issues.push({ path: `${path}.validation.min`, message: 'min is above max.' });
  }
  if (below(rules.minLength, rules.maxLength)) {
    issues.push({
      path: `${path}.validation.minLength`,
      message: 'minLength is above maxLength.',
    });
  }
  if (below(rules.minDate, rules.maxDate)) {
    issues.push({
      path: `${path}.validation.minDate`,
      message: 'minDate is after maxDate.',
    });
  }
  if (below(rules.minItems, rules.maxItems)) {
    issues.push({
      path: `${path}.validation.minItems`,
      message: 'minItems is above maxItems.',
    });
  }
  if (
    options.length > 0 &&
    (rules.minItems ?? 0) > options.length
  ) {
    issues.push({
      path: `${path}.validation.minItems`,
      message: 'minItems is above the number of options.',
    });
  }
  const limit = ANSWER_TEXT_LIMITS[field.type];
  if (limit && rules.maxLength !== undefined && rules.maxLength > limit) {
    issues.push({
      path: `${path}.validation.maxLength`,
      message: `At most ${limit} for a ${field.type} field.`,
    });
  }
  if (field.type === 'integer') {
    for (const bound of ['min', 'max'] as const) {
      const value = rules[bound];
      if (value !== undefined && !Number.isSafeInteger(value)) {
        issues.push({
          path: `${path}.validation.${bound}`,
          message: 'A whole number.',
        });
      }
    }
  }
  if (rules.pattern !== undefined) {
    const problem = patternProblem(rules.pattern);
    if (problem !== null) {
      issues.push({ path: `${path}.validation.pattern`, message: problem });
    }
  }
  if (issues.length === 0 && field.default !== undefined) {
    const problem = valueIssues(field, field.default);
    if (problem !== null) {
      issues.push({ path: `${path}.default`, message: problem });
    }
  }
  return issues;
}
