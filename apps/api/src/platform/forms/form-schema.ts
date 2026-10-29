import { z } from 'zod';
import { patternProblem } from '../custom-fields/custom-field.pattern.js';
import {
  conditionIssues,
  RULE_LIMITS,
  type RuleCondition,
  type RuleField,
} from './form-rules.js';

/**
 * A form's definition: data, never code (docs/forms.md, "The schema"). One
 * canonical descriptor, validated here when a draft is saved and again when
 * it is published; the web renderer and the submissions validator read the
 * same shape. Sections in order, each with its fields in order; every
 * field has a stable `key` (its answer's key), unique in the whole form.
 *
 * Formats: 1 is fields and sections; 2 adds conditions (`visibleWhen` on
 * a section or a field, `requiredWhen` on a field, form-rules.ts); 3 adds
 * pages (a section that `startsPage`: a wizard) and the repeatable `group`
 * field (its own `fields`, one level, `minItems` / `maxItems` under a hard
 * cap); 4 adds `optionsSource` on a choice field in place of `options`
 * (a provider trusted code registered, form-option-sources.service.ts). A stored
 * definition stays valid and means what it meant; what a later format adds
 * is refused in an earlier one. Every object is strict: an unknown property
 * is refused, not stored.
 */

/** The descriptor formats read, oldest first; new definitions are the last. */
export const FORM_SCHEMA_FORMATS = [1, 2, 3, 4] as const;
/** The format a new definition takes. */
export const FORM_SCHEMA_FORMAT = 4;

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
  'group',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
/** The types a group's own fields may have: anything but a group (one level). */
const GROUP_FIELD_TYPES = FORM_FIELD_TYPES.filter(
  (type): type is Exclude<FormFieldType, 'group'> => type !== 'group',
);

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
  /** The fields of one group (counted in `fields` too). */
  groupFields: 20,
  /** A group's items, at most, whatever its `maxItems`. */
  groupItems: 50,
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
/** Whether the text has a control character but tab and line breaks (by code, not a regex of them). */
const hasControl = (value: string) =>
  [...value].some((char) => {
    const code = char.codePointAt(0)!;
    return (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0x7f;
  });

/** Plain text of at most `max` characters: no markup, no control characters. */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !MARKUP.test(value), {
      message: 'Plain text only: no HTML tags.',
    })
    .refine((value) => !hasControl(value), {
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

const ruleValue = z.union([z.string().max(1_000), z.number(), z.boolean()]);
const predicateSchema = z.discriminatedUnion('op', [
  z.object({ field: key, op: z.enum(['eq', 'ne']), value: ruleValue }).strict(),
  z
    .object({
      field: key,
      op: z.enum(['gt', 'gte', 'lt', 'lte']),
      value: z.union([z.number(), z.string().max(10)]),
    })
    .strict(),
  z
    .object({
      field: key,
      op: z.literal('in'),
      value: z
        .array(z.union([z.string().max(1_000), z.number()]))
        .max(RULE_LIMITS.values),
    })
    .strict(),
  z
    .object({
      field: key,
      op: z.literal('contains'),
      value: z.string().max(100),
    })
    .strict(),
  z.object({ field: key, op: z.literal('isEmpty') }).strict(),
]);

/**
 * A condition (form-rules.ts): a predicate on an earlier field's answer, or
 * a group of them (`all`, `any`, `not`), at most RULE_LIMITS deep and wide.
 */
export const formConditionSchema: z.ZodType<RuleCondition> = z
  .union([
    predicateSchema,
    z
      .object({
        get all() {
          return z.array(formConditionSchema).max(RULE_LIMITS.predicates);
        },
      })
      .strict(),
    z
      .object({
        get any() {
          return z.array(formConditionSchema).max(RULE_LIMITS.predicates);
        },
      })
      .strict(),
    z
      .object({
        get not() {
          return formConditionSchema;
        },
      })
      .strict(),
  ])
  .meta({
    id: 'FormCondition',
    description:
      'A predicate { field, op, value } on an earlier field, or { all: [...] }, { any: [...] }, { not: ... }.',
  });

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
const VALIDATION_KEYS: Record<FormFieldType, (keyof FormFieldValidation)[]> = {
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
  group: ['minItems', 'maxItems'],
};

const fieldShape = z
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
    optionsSource: z
      .object({
        provider: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,63}$/)
          .describe(
            'A provider registered by trusted server code (GET /v1/forms/option-sources), never a URL or a query.',
          ),
      })
      .strict()
      .optional()
      .describe(
        'In place of `options` (format 4): the choices come from the provider, filtered to what the person filling in may see, and each answer is checked against it on the server. Read them at GET /v1/forms/{id}/options/{key}.',
      ),
    validation: validationSchema.optional(),
    visibleWhen: formConditionSchema
      .optional()
      .describe(
        'Shown only when this holds (format 2); a hidden field has no answer.',
      ),
    requiredWhen: formConditionSchema
      .optional()
      .describe('Required, when shown, whenever this holds (format 2).'),
    translations: translations({
      label: plainText(200),
      help: plainText(1_000),
      placeholder: plainText(200),
    }),
  })
  .strict();

/** A field of a group: no group in it (one level), no conditions of its own. */
export const groupFieldSchema = fieldShape
  .omit({ visibleWhen: true, requiredWhen: true, optionsSource: true })
  .extend({ type: z.enum(GROUP_FIELD_TYPES) })
  .strict();
export type GroupField = z.infer<typeof groupFieldSchema>;

export const formFieldSchema = fieldShape
  .extend({
    fields: z
      .array(groupFieldSchema)
      .max(FORM_LIMITS.groupFields)
      .optional()
      .describe(
        "A group's fields (format 3): each item answers them, as an object by key.",
      ),
  })
  .strict();
export type FormField = z.infer<typeof formFieldSchema>;

export const formSectionSchema = z
  .object({
    key,
    title: plainText(200).optional(),
    description: plainText(2_000).optional(),
    visibleWhen: formConditionSchema
      .optional()
      .describe('Shown only when this holds (format 2): its fields too.'),
    startsPage: z
      .boolean()
      .optional()
      .describe(
        'Starts a new page (format 3): the form is then a wizard, one page at a time.',
      ),
    fields: z.array(formFieldSchema).max(FORM_LIMITS.fields),
    translations: translations({
      title: plainText(200),
      description: plainText(2_000),
    }),
  })
  .strict();

/** A form's definition (a draft, or a published version's snapshot). */
export const formDefinitionSchema = z
  .object({
    format: z
      .union(FORM_SCHEMA_FORMATS.map((format) => z.literal(format)))
      .default(FORM_SCHEMA_FORMAT)
      .describe(
        'The descriptor format: 1 (fields), 2 (and conditions), 3 (and pages and repeatable groups). Left out: the latest.',
      ),
    sections: z.array(formSectionSchema).max(FORM_LIMITS.sections),
  })
  .strict()
  .meta({
    example: {
      format: 3,
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
            {
              key: 'details',
              type: 'textarea',
              label: 'What is it about?',
              visibleWhen: { field: 'topic', op: 'eq', value: 'other' },
              requiredWhen: { field: 'topic', op: 'eq', value: 'other' },
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

/**
 * The type of every field by key, a group's own as `<group>.<key>`: what a
 * published version fixes (`keyTypes`).
 */
export const keyTypesOf = (definition: FormDefinition) =>
  Object.fromEntries(
    fieldsOf(definition).flatMap((field) => [
      [field.key, field.type],
      ...(field.fields ?? []).map((sub) => [
        `${field.key}.${sub.key}`,
        sub.type,
      ]),
    ]),
  ) as Record<string, FormFieldType>;

/** The pages of a definition: runs of sections, a new one at each `startsPage`. */
export function pagesOf<S extends { startsPage?: boolean }>(
  sections: readonly S[],
): S[][] {
  const pages: S[][] = [];
  for (const section of sections) {
    if (pages.length === 0 || section.startsPage) pages.push([]);
    pages.at(-1)!.push(section);
  }
  return pages;
}

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
  valueIssues: (field: FormField, value: unknown) => string | null = () => null,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const bytes = Buffer.byteLength(JSON.stringify(definition));
  if (bytes > FORM_LIMITS.bytes) {
    issues.push({
      path: '',
      message: `The form is ${bytes} bytes as JSON: at most ${FORM_LIMITS.bytes}.`,
    });
  }
  const total = fieldsOf(definition).reduce(
    (sum, field) => sum + 1 + (field.fields?.length ?? 0),
    0,
  );
  if (total > FORM_LIMITS.fields) {
    issues.push({
      path: 'sections',
      message: `At most ${FORM_LIMITS.fields} fields in a form (${total}).`,
    });
  }
  const sectionKeys = new Set<string>();
  const fieldKeys = new Set<string>();
  // What a condition may read: the fields before it (form-rules.ts).
  const earlier = new Map<string, RuleField>();
  const all = new Set(fieldsOf(definition).map((field) => field.key));
  const rule = (condition: RuleCondition | undefined, path: string) => {
    if (condition === undefined) return;
    if (definition.format < 2) {
      issues.push({ path, message: 'Conditions take format 2.' });
      return;
    }
    for (const issue of conditionIssues(condition, earlier, all)) {
      issues.push({
        path: issue.path ? `${path}.${issue.path}` : path,
        message: issue.message,
      });
    }
  };
  for (const [s, section] of definition.sections.entries()) {
    const at = `sections.${s}`;
    if (sectionKeys.has(section.key)) {
      issues.push({ path: `${at}.key`, message: 'Section keys must differ.' });
    }
    sectionKeys.add(section.key);
    rule(section.visibleWhen, `${at}.visibleWhen`);
    if (section.startsPage !== undefined && definition.format < 3) {
      issues.push({
        path: `${at}.startsPage`,
        message: 'Pages take format 3.',
      });
    }
    for (const [f, field] of section.fields.entries()) {
      const path = `${at}.fields.${f}`;
      rule(field.visibleWhen, `${path}.visibleWhen`);
      rule(field.requiredWhen, `${path}.requiredWhen`);
      if (field.required && field.requiredWhen !== undefined) {
        issues.push({
          path: `${path}.requiredWhen`,
          message: 'A field always required takes no requiredWhen.',
        });
      }
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
      if (field.optionsSource !== undefined) {
        issues.push(...sourceIssues(field, path, definition.format));
      }
      issues.push(...fieldIssues(field, path, valueIssues));
      if (field.type === 'group') {
        issues.push(
          ...groupIssues(field, path, definition.format, keyTypes, valueIssues),
        );
      } else if (field.fields !== undefined) {
        issues.push({
          path: `${path}.fields`,
          message: `A ${field.type} field has no fields of its own.`,
        });
      }
      if (!earlier.has(field.key)) earlier.set(field.key, field);
    }
  }
  return issues;
}

/** A choice field's option source's own problems (whether it is registered: the service's). */
function sourceIssues(
  field: FormField,
  path: string,
  format: number,
): SchemaIssue[] {
  const at = `${path}.optionsSource`;
  if (format < 4)
    return [{ path: at, message: 'Option sources take format 4.' }];
  if (!CHOICE_TYPES.includes(field.type)) {
    return [
      { path: at, message: `A ${field.type} field takes no option source.` },
    ];
  }
  const issues: SchemaIssue[] = [];
  if (field.options !== undefined) {
    issues.push({
      path: `${path}.options`,
      message: 'Options or an option source, not both.',
    });
  }
  if (field.default !== undefined) {
    issues.push({
      path: `${path}.default`,
      message: 'A field with an option source takes no default.',
    });
  }
  return issues;
}

/** A group's own problems: its format, its fields, and its item bounds. */
function groupIssues(
  field: FormField,
  path: string,
  format: number,
  keyTypes: Record<string, string>,
  valueIssues: (field: FormField, value: unknown) => string | null,
): SchemaIssue[] {
  if (format < 3) {
    return [{ path: `${path}.type`, message: 'Groups take format 3.' }];
  }
  const issues: SchemaIssue[] = [];
  const fields = field.fields ?? [];
  if (fields.length === 0) {
    issues.push({ path: `${path}.fields`, message: 'A group needs fields.' });
  }
  if (field.default !== undefined) {
    issues.push({
      path: `${path}.default`,
      message: 'A group takes no default.',
    });
  }
  const rules = field.validation ?? {};
  if ((rules.maxItems ?? 0) > FORM_LIMITS.groupItems) {
    issues.push({
      path: `${path}.validation.maxItems`,
      message: `At most ${FORM_LIMITS.groupItems} items in a group.`,
    });
  }
  if ((rules.minItems ?? 0) > FORM_LIMITS.groupItems) {
    issues.push({
      path: `${path}.validation.minItems`,
      message: `At most ${FORM_LIMITS.groupItems} items in a group.`,
    });
  }
  const keys = new Set<string>();
  for (const [index, sub] of fields.entries()) {
    const at = `${path}.fields.${index}`;
    if (keys.has(sub.key)) {
      issues.push({
        path: `${at}.key`,
        message: "Keys must differ in a group's fields.",
      });
    }
    keys.add(sub.key);
    const fixed = keyTypes[`${field.key}.${sub.key}`];
    if (fixed && fixed !== sub.type) {
      issues.push({
        path: `${at}.type`,
        message: `A published version has "${field.key}.${sub.key}" as ${fixed}: its type can't change. Use a new key.`,
      });
    }
    issues.push(...fieldIssues(sub, at, valueIssues));
  }
  return issues;
}

function fieldIssues(
  field: FormField | GroupField,
  path: string,
  valueIssues: (field: FormField, value: unknown) => string | null,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const options = field.options ?? [];
  if (field.type === 'group') {
    // Its options: none; its default: groupIssues.
    if (field.options !== undefined) {
      issues.push({
        path: `${path}.options`,
        message: 'A group takes no options.',
      });
    }
    const rules = field.validation ?? {};
    for (const name of Object.keys(rules) as (keyof FormFieldValidation)[]) {
      if (rules[name] !== undefined && !VALIDATION_KEYS.group.includes(name)) {
        issues.push({
          path: `${path}.validation.${name}`,
          message: `A group field takes no ${name}.`,
        });
      }
    }
    if ((rules.minItems ?? 0) > (rules.maxItems ?? Infinity)) {
      issues.push({
        path: `${path}.validation.minItems`,
        message: 'minItems is above maxItems.',
      });
    }
    return issues;
  }
  const sourced = 'optionsSource' in field && field.optionsSource !== undefined;
  // A sourced field's choices are the provider's (sourceIssues): none here.
  if (CHOICE_TYPES.includes(field.type) && !sourced) {
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
  } else if (!sourced && field.options !== undefined) {
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
    issues.push({
      path: `${path}.validation.min`,
      message: 'min is above max.',
    });
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
  if (options.length > 0 && (rules.minItems ?? 0) > options.length) {
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
  if (issues.length === 0 && !sourced && field.default !== undefined) {
    const problem = valueIssues(field, field.default);
    if (problem !== null) {
      issues.push({ path: `${path}.default`, message: problem });
    }
  }
  return issues;
}
