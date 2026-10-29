import { z } from 'zod';
import {
  type CompiledPattern,
  compilePattern,
} from '../custom-fields/custom-field.pattern.js';
import {
  ANSWER_TEXT_LIMITS,
  fieldsOf,
  type FormDefinition,
  type FormField,
  type SchemaIssue,
} from './form-schema.js';
import { walkForm } from './form-rules.js';

/**
 * How a submission's answers are checked: on the server, against the
 * published version it names, never against what the client says the form
 * is. Pure functions (docs/forms.md, "Answers").
 *
 * - Only the version's keys: an unknown key is refused (`answers.<key>`),
 *   not dropped, so a client out of step learns it.
 * - Empty (absent, null, a blank string, an empty list) takes the field's
 *   default, else is refused when required, else left out.
 * - Normalized: text trimmed, numbers given as numeric strings read as
 *   numbers; the stored answer holds the version's keys alone.
 * - Conditions (format 2) decide in form order which fields show and which
 *   are required (form-rules.ts). A hidden field's answer is stripped,
 *   deterministically: neither checked, nor stored, nor filled with its
 *   default, whatever the client sent; it is never required.
 */

/** The answers as JSON, in bytes, at most (under the request's own 100 KiB). */
export const MAX_ANSWERS_BYTES = 64 * 1024;

const email = z.email();
// http(s) only: a `javascript:` link a reviewer's browser shows would run.
const url = z.url({ protocol: /^https?$/ });

/** Compiled once per pattern text: a version's patterns don't change. */
const patterns = new Map<string, CompiledPattern | null>();
function pattern(source: string) {
  if (!patterns.has(source)) {
    if (patterns.size > 1_000) patterns.clear();
    try {
      patterns.set(source, compilePattern(source));
    } catch {
      patterns.set(source, null); // saved patterns compile: refused below if not
    }
  }
  return patterns.get(source)!;
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

type Checked =
  { ok: true; value: unknown } | { ok: false; message: string; index?: number };

const refuse = (message: string, index?: number): Checked => ({
  ok: false,
  message,
  index,
});

const numberOf = (value: unknown) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return Number.NaN;
};

/** One non-empty value checked against its field, normalized. */
export function checkValue(field: FormField, value: unknown): Checked {
  const rules = field.validation ?? {};
  const values = (field.options ?? []).map((option) => option.value);
  switch (field.type) {
    case 'checkbox':
      if (typeof value !== 'boolean') return refuse('Must be true or false.');
      if (field.required && !value) return refuse('Must be checked.');
      return { ok: true, value };
    case 'integer':
    case 'decimal': {
      const number = numberOf(value);
      if (!Number.isFinite(number)) return refuse('Must be a number.');
      if (field.type === 'integer' && !Number.isSafeInteger(number)) {
        return refuse('Must be a whole number.');
      }
      if (rules.decimals !== undefined) {
        const [, fraction = ''] = String(number).split('.');
        if (fraction.length > rules.decimals || String(number).includes('e')) {
          return refuse(`At most ${rules.decimals} decimals.`);
        }
      }
      if (rules.min !== undefined && number < rules.min) {
        return refuse(`At least ${rules.min}.`);
      }
      if (rules.max !== undefined && number > rules.max) {
        return refuse(`At most ${rules.max}.`);
      }
      return { ok: true, value: number };
    }
    case 'date': {
      if (typeof value !== 'string' || !z.iso.date().safeParse(value).success) {
        return refuse('Must be a date (YYYY-MM-DD).');
      }
      if (rules.minDate !== undefined && value < rules.minDate) {
        return refuse(`On ${rules.minDate} or later.`);
      }
      if (rules.maxDate !== undefined && value > rules.maxDate) {
        return refuse(`On ${rules.maxDate} or earlier.`);
      }
      return { ok: true, value };
    }
    case 'select':
    case 'radio':
      if (typeof value !== 'string' || !values.includes(value)) {
        return refuse('Must be one of the options.');
      }
      return { ok: true, value };
    case 'multiSelect': {
      if (!Array.isArray(value)) return refuse('Must be a list of options.');
      if (value.length > values.length) return refuse('Too many choices.');
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'string' || !values.includes(item)) {
          return refuse('Must be one of the options.', index);
        }
        if (value.indexOf(item) !== index) {
          return refuse('Each choice may appear once.', index);
        }
      }
      if (rules.minItems !== undefined && value.length < rules.minItems) {
        return refuse(`At least ${rules.minItems} choices.`);
      }
      if (rules.maxItems !== undefined && value.length > rules.maxItems) {
        return refuse(`At most ${rules.maxItems} choices.`);
      }
      return { ok: true, value: [...value] };
    }
    default: {
      // text, textarea, email, url
      if (typeof value !== 'string') return refuse('Must be text.');
      const text = value.trim();
      const max = rules.maxLength ?? ANSWER_TEXT_LIMITS[field.type]!;
      if (text.length > max) return refuse(`At most ${max} characters.`);
      if (rules.minLength !== undefined && text.length < rules.minLength) {
        return refuse(`At least ${rules.minLength} characters.`);
      }
      if (
        rules.pattern !== undefined &&
        pattern(rules.pattern)?.test(text) !== true
      ) {
        return refuse('Does not match the expected format.');
      }
      if (field.type === 'email' && !email.safeParse(text).success) {
        return refuse('Must be an email address.');
      }
      if (field.type === 'url' && !url.safeParse(text).success) {
        return refuse('Must be an http(s) URL.');
      }
      return { ok: true, value: text };
    }
  }
}

/** A default's problem, for the schema's own checks (`definitionIssues`). */
export const defaultIssue = (field: FormField, value: unknown) => {
  const checked = checkValue({ ...field, required: false }, value);
  return checked.ok ? null : checked.message;
};

/**
 * The answers of a submission checked against a version's definition:
 * the normalized answers, or the issues at `answers.<key>` (and
 * `answers.<key>.<index>` in a list).
 */
export function checkAnswers(
  definition: FormDefinition,
  input: unknown,
):
  | { ok: true; answers: Record<string, unknown> }
  | { ok: false; issues: SchemaIssue[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ path: 'answers', message: 'An object of answers by key.' }],
    };
  }
  const given = input as Record<string, unknown>;
  const fields = fieldsOf(definition);
  const known = new Set(fields.map((field) => field.key));
  const issues: SchemaIssue[] = [];
  for (const key of Object.keys(given)) {
    if (!known.has(key)) {
      issues.push({
        path: `answers.${key.slice(0, 64)}`,
        message: 'Not a field of this version of the form.',
      });
    }
  }
  const { answers } = walkForm(definition.sections, (field, required) => {
    const value = Object.hasOwn(given, field.key)
      ? given[field.key]
      : undefined;
    if (isEmpty(value) && field.default === undefined) {
      if (required) {
        issues.push({
          path: `answers.${field.key}`,
          message: 'This field is required.',
        });
      }
      return undefined;
    }
    // A default is checked as an answer (a required checkbox's `false` is refused).
    const checked = checkValue(
      { ...field, required },
      isEmpty(value) ? field.default : value,
    );
    if (checked.ok) return checked.value;
    issues.push({
      path:
        checked.index === undefined
          ? `answers.${field.key}`
          : `answers.${field.key}.${checked.index}`,
      message: checked.message,
    });
    return undefined;
  });
  if (issues.length > 0) return { ok: false, issues };
  const bytes = Buffer.byteLength(JSON.stringify(answers));
  if (bytes > MAX_ANSWERS_BYTES) {
    return {
      ok: false,
      issues: [
        {
          path: 'answers',
          message: `The answers are ${bytes} bytes as JSON: at most ${MAX_ANSWERS_BYTES}.`,
        },
      ],
    };
  }
  return { ok: true, answers };
}
