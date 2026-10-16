import { z } from 'zod';
import type {
  CustomFieldDefinition,
  CustomFieldType,
  CustomFieldValidation,
} from './custom-field.types.js';

/**
 * How custom values are checked: one Zod schema per field type, built from
 * the definitions at runtime (they change without a deploy). Pure functions:
 * the service caches what they build.
 *
 * Values as stored in JSONB, by type:
 * - text, longText, email, url, select: a string;
 * - number: a JSON number; boolean: true / false;
 * - date: a calendar date, `YYYY-MM-DD` (sorts as text, casts to `date`);
 * - multiSelect: an array of distinct option values.
 */

/** A field's key: its JSON key, and part of SQL the list helper writes, so a strict slug. */
export const CUSTOM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** The longest value of each text type, whatever the field's own `maxLength`. */
export const TEXT_LIMITS: Partial<Record<CustomFieldType, number>> = {
  text: 1_000,
  longText: 10_000,
  email: 254,
  url: 2_048,
};

/** Which `validation` keys each type takes. */
const VALIDATION_KEYS: Record<
  CustomFieldType,
  (keyof CustomFieldValidation)[]
> = {
  text: ['minLength', 'maxLength', 'pattern'],
  longText: ['minLength', 'maxLength', 'pattern'],
  email: ['minLength', 'maxLength', 'pattern'],
  url: ['minLength', 'maxLength', 'pattern'],
  number: ['min', 'max'],
  multiSelect: ['min', 'max'],
  boolean: [],
  date: [],
  select: [],
};

type FieldShape = Pick<
  CustomFieldDefinition,
  'type' | 'options' | 'validation'
>;

/** An administrator's pattern, anchored: it must match the whole value. */
const compilePattern = (pattern: string) => new RegExp(`^(?:${pattern})$`, 'u');

/** The schema of one field's value (never null: null means "no value" and is handled by the caller). */
export function valueSchema(field: FieldShape): z.ZodType {
  const rules = field.validation ?? {};
  switch (field.type) {
    case 'number': {
      let schema = z.number();
      if (rules.min !== undefined) schema = schema.min(rules.min);
      if (rules.max !== undefined) schema = schema.max(rules.max);
      return schema;
    }
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.iso.date();
    case 'select': {
      const values = (field.options ?? []).map((option) => option.value);
      return z.string().refine((value) => values.includes(value), {
        message: `Must be one of: ${values.join(', ')}.`,
      });
    }
    case 'multiSelect': {
      const values = (field.options ?? []).map((option) => option.value);
      let schema = z.array(
        z.string().refine((value) => values.includes(value), {
          message: `Must be one of: ${values.join(', ')}.`,
        }),
      );
      if (rules.min !== undefined) schema = schema.min(rules.min);
      if (rules.max !== undefined) schema = schema.max(rules.max);
      return schema.refine((items) => new Set(items).size === items.length, {
        message: 'Each choice may appear once.',
      });
    }
    default: {
      // text, longText, email, url
      let schema = z.string().max(rules.maxLength ?? TEXT_LIMITS[field.type]!);
      if (rules.minLength !== undefined) {
        schema = schema.min(rules.minLength);
      }
      if (rules.pattern !== undefined) {
        schema = schema.regex(compilePattern(rules.pattern), {
          message: 'Does not match the expected format.',
        });
      }
      if (field.type === 'email') {
        return schema.refine((value) => z.email().safeParse(value).success, {
          message: 'Must be an email address.',
        });
      }
      if (field.type === 'url') {
        // http(s) only: a `javascript:` link rendered by a client would run.
        const url = z.url({ protocol: /^https?$/ });
        return schema.refine((value) => url.safeParse(value).success, {
          message: 'Must be an http(s) URL.',
        });
      }
      return schema;
    }
  }
}

/**
 * The schema of `custom` on a write, for these (active) fields:
 *
 * - `create`: required fields must have a value (or a default, filled in);
 *   `null` means none.
 * - `update`: a partial patch; `null` removes a key, except a required one.
 *
 * Unknown keys (and keys of inactive fields) are refused one by one, so the
 * error names the field: `custom.region`. The output holds only known keys.
 */
export function customValuesSchema(
  fields: readonly CustomFieldDefinition[],
  mode: 'create' | 'update',
): z.ZodType<Record<string, unknown>, Record<string, unknown>> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const schemas = new Map(
    fields.map((field) => [field.key, valueSchema(field)]),
  );
  return z
    .record(z.string(), z.unknown())
    .superRefine((input, ctx) => {
      for (const [key, value] of Object.entries(input)) {
        const field = byKey.get(key);
        if (!field) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Unknown custom field.',
          });
          continue;
        }
        if (value === null || value === undefined) {
          if (field.required && mode === 'update' && value === null) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: 'This field is required: it cannot be removed.',
            });
          }
          continue;
        }
        const parsed = schemas.get(key)!.safeParse(value);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({
              code: 'custom',
              path: [key, ...issue.path],
              message: issue.message,
            });
          }
        }
      }
      if (mode === 'create') {
        for (const field of fields) {
          const value = input[field.key];
          if (
            field.required &&
            (value === null || value === undefined) &&
            field.defaultValue == null
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [field.key],
              message: 'This field is required.',
            });
          }
        }
      }
    })
    .transform((input) => {
      const output: Record<string, unknown> = {};
      for (const field of fields) {
        const value = input[field.key];
        if (mode === 'update') {
          if (value !== undefined) output[field.key] = value; // null: remove
        } else if (value !== null && value !== undefined) {
          output[field.key] = value;
        } else if (field.defaultValue != null) {
          output[field.key] = field.defaultValue;
        }
      }
      return output;
    });
}

/** A definition's problems, as `{ path, message }` (empty: valid). */
export function definitionIssues(
  field: FieldShape & { defaultValue: unknown },
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const choice = field.type === 'select' || field.type === 'multiSelect';
  const options = field.options ?? [];
  if (choice) {
    if (options.length === 0) {
      issues.push({
        path: 'options',
        message: 'A choice field needs options.',
      });
    }
    if (new Set(options.map((o) => o.value)).size !== options.length) {
      issues.push({ path: 'options', message: 'Option values must differ.' });
    }
    // An import file lists a multiSelect's choices separated by commas.
    if (
      field.type === 'multiSelect' &&
      options.some((o) => o.value.includes(','))
    ) {
      issues.push({
        path: 'options',
        message: 'A comma in an option value would split it in an import file.',
      });
    }
  } else if (options.length > 0) {
    issues.push({
      path: 'options',
      message: `A ${field.type} field takes no options.`,
    });
  }
  const rules = field.validation ?? {};
  const allowed = VALIDATION_KEYS[field.type];
  for (const key of Object.keys(rules) as (keyof CustomFieldValidation)[]) {
    if (rules[key] !== undefined && !allowed.includes(key)) {
      issues.push({
        path: `validation.${key}`,
        message: `A ${field.type} field takes no ${key}.`,
      });
    }
  }
  if (
    rules.min !== undefined &&
    rules.max !== undefined &&
    rules.min > rules.max
  ) {
    issues.push({ path: 'validation.min', message: 'min is above max.' });
  }
  if (
    rules.minLength !== undefined &&
    rules.maxLength !== undefined &&
    rules.minLength > rules.maxLength
  ) {
    issues.push({
      path: 'validation.minLength',
      message: 'minLength is above maxLength.',
    });
  }
  const limit = TEXT_LIMITS[field.type];
  if (limit && rules.maxLength !== undefined && rules.maxLength > limit) {
    issues.push({
      path: 'validation.maxLength',
      message: `At most ${limit} for a ${field.type} field.`,
    });
  }
  if (rules.pattern !== undefined) {
    try {
      compilePattern(rules.pattern);
    } catch {
      issues.push({
        path: 'validation.pattern',
        message: 'Not a valid regular expression.',
      });
    }
  }
  if (issues.length === 0 && field.defaultValue != null) {
    const parsed = valueSchema(field).safeParse(field.defaultValue);
    if (!parsed.success) {
      issues.push({
        path: 'default',
        message: parsed.error.issues[0]?.message ?? 'Invalid default.',
      });
    }
  }
  return issues;
}

/**
 * A value read from an import file (CSV and spreadsheet cells are text) as
 * its field's type: numbers, booleans (`true`/`false`, `1`/`0`, `yes`/`no`),
 * dates (a spreadsheet's ISO timestamp keeps its day), choices (a JSON array,
 * as exports write them, or comma-separated; an option's label, as the
 * template's dropdown shows it, stands for its value). An empty cell is no
 * value. What can't be converted is passed on as is, for validation to refuse.
 */
export function coerceImported(
  field: Pick<CustomFieldDefinition, 'type' | 'options'>,
  raw: unknown,
): unknown {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  /** A choice by its value, or by its label (or value) whatever the case. */
  const choice = (item: unknown) => {
    if (typeof item !== 'string') return item;
    const options = field.options ?? [];
    if (options.some((option) => option.value === item)) return item;
    const lower = item.trim().toLowerCase();
    return (
      options.find(
        (option) =>
          option.label.toLowerCase() === lower ||
          option.value.toLowerCase() === lower,
      )?.value ?? item
    );
  };
  if (typeof raw !== 'string') {
    // JSON imports bring typed values; a list's items may still be labels.
    return field.type === 'multiSelect' && Array.isArray(raw)
      ? raw.map(choice)
      : raw;
  }
  const text = raw.trim();
  switch (field.type) {
    case 'number': {
      const value = Number(text);
      return text !== '' && Number.isFinite(value) ? value : raw;
    }
    case 'boolean': {
      const lower = text.toLowerCase();
      if (['true', '1', 'yes'].includes(lower)) return true;
      if (['false', '0', 'no'].includes(lower)) return false;
      return raw;
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text;
    case 'select':
      return choice(text);
    case 'multiSelect': {
      if (text.startsWith('[')) {
        try {
          const items: unknown = JSON.parse(text);
          return Array.isArray(items) ? items.map(choice) : items;
        } catch {
          return raw;
        }
      }
      return text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map(choice);
    }
    default:
      return raw;
  }
}
