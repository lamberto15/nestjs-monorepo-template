import type { TFunction } from 'i18next';
import {
  TEXT_LIMITS,
  hasOptions,
  isTextual,
  type CustomField,
} from '@/lib/custom-fields';
import { z } from '@/lib/zod';

/**
 * A custom value as its input holds it (a draft) and back
 * (docs/custom-fields.md, "For clients"). Text types, number, date and
 * select are strings; boolean is true/false, `undefined` while untouched;
 * multiSelect is the chosen option values.
 */
export type CustomDraft = string | boolean | string[] | undefined;
export type CustomDrafts = Record<string, CustomDraft>;

/** The draft of a stored (or default) value. */
export function toDraft(field: CustomField, value: unknown): CustomDraft {
  if (value === null || value === undefined) {
    return field.type === 'multiSelect' ? [] : undefined;
  }
  switch (field.type) {
    case 'boolean':
      return value === true;
    case 'number':
      return typeof value === 'number' ? String(value) : undefined;
    case 'multiSelect':
      return Array.isArray(value) ? value.map(String) : [];
    default:
      return typeof value === 'string' ? value : undefined;
  }
}

/**
 * What the inputs start with: the record's stored values, or on create the
 * fields' defaults (the API fills them in anyway; showing them says so).
 */
export function initialDrafts(
  fields: readonly CustomField[],
  stored?: Record<string, unknown>,
): CustomDrafts {
  return Object.fromEntries(
    fields.map((field) => [
      field.key,
      toDraft(field, stored ? stored[field.key] : field.default),
    ]),
  );
}

const isEmpty = (draft: CustomDraft) =>
  draft === undefined ||
  draft === '' ||
  (Array.isArray(draft) && draft.length === 0);

/** Whether a whole value matches a pattern; a pattern JS can't run is the API's to judge. */
function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(text);
  } catch {
    return true;
  }
}

/** The error of one draft, or undefined: the API's rules, from the definition. */
export function draftError(
  field: CustomField,
  draft: CustomDraft,
  t: TFunction,
): string | undefined {
  if (isEmpty(draft)) {
    // A boolean left alone is no value; `false` is one.
    return field.required && draft !== false
      ? t('customFields.required')
      : undefined;
  }
  const rules = field.validation ?? {};
  if (isTextual(field.type)) {
    const text = String(draft);
    const maxLength = Math.min(
      rules.maxLength ?? Infinity,
      TEXT_LIMITS[field.type as keyof typeof TEXT_LIMITS],
    );
    if (text.length > maxLength) {
      return t('customFields.maxLength', { limit: maxLength });
    }
    if (rules.minLength !== undefined && text.length < rules.minLength) {
      return t('customFields.minLength', { limit: rules.minLength });
    }
    if (field.type === 'email' && !z.email().safeParse(text).success) {
      return t('customFields.email');
    }
    if (field.type === 'url') {
      const ok = z.url({ protocol: /^https?$/ }).safeParse(text).success;
      if (!ok) return t('customFields.url');
    }
    if (rules.pattern && !matches(rules.pattern, text)) {
      return t('customFields.pattern');
    }
  }
  if (field.type === 'number') {
    const number = Number(draft);
    if (!Number.isFinite(number)) return t('customFields.number');
    if (rules.min !== undefined && number < rules.min) {
      return t('customFields.min', { limit: rules.min });
    }
    if (rules.max !== undefined && number > rules.max) {
      return t('customFields.max', { limit: rules.max });
    }
  }
  if (field.type === 'multiSelect' && Array.isArray(draft)) {
    if (rules.min !== undefined && draft.length < rules.min) {
      return t('customFields.minChoices', { limit: rules.min });
    }
    if (rules.max !== undefined && draft.length > rules.max) {
      return t('customFields.maxChoices', { limit: rules.max });
    }
  }
  if (hasOptions(field.type)) {
    const known = new Set((field.options ?? []).map((o) => o.value));
    const chosen = Array.isArray(draft) ? draft : [String(draft)];
    if (chosen.some((value) => !known.has(value))) {
      return t('customFields.option');
    }
  }
  return undefined;
}

/** Every draft's error, by key. */
export function draftErrors(
  fields: readonly CustomField[],
  drafts: CustomDrafts,
  t: TFunction,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const message = draftError(field, drafts[field.key], t);
    if (message) errors[field.key] = message;
  }
  return errors;
}

/** The JSON value of a draft that passed `draftError`; undefined: no value. */
export function valueOf(field: CustomField, draft: CustomDraft): unknown {
  if (isEmpty(draft)) return undefined;
  return field.type === 'number' ? Number(draft) : draft;
}

/**
 * The `custom` of a request body from the drafts. On create, the fields
 * with a value that differs from `baseline` (the defaults the form started
 * with: the API fills those in itself, and a user without access to
 * `custom` may still create). On update (`stored`), only the keys that
 * changed; one emptied is `null` (the API removes it).
 */
export function customBody(
  fields: readonly CustomField[],
  drafts: CustomDrafts,
  options: { stored?: Record<string, unknown>; baseline?: CustomDrafts } = {},
): Record<string, unknown> {
  const { stored, baseline } = options;
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const value = valueOf(field, drafts[field.key]);
    if (!stored) {
      const same =
        baseline &&
        JSON.stringify(valueOf(field, baseline[field.key])) ===
          JSON.stringify(value);
      if (value !== undefined && !same) body[field.key] = value;
      continue;
    }
    const before = stored[field.key] ?? undefined;
    if (JSON.stringify(value ?? undefined) === JSON.stringify(before)) continue;
    body[field.key] = value ?? null;
  }
  return body;
}

/**
 * The API's errors on `custom.<key>` as messages by key (a 400
 * `validation_failed` names the field, docs/custom-fields.md).
 */
export function serverErrors(
  errors: readonly { path: string; message: string }[] | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (errors ?? [])
      .filter((error) => error.path.startsWith('custom.'))
      .map((error) => [error.path.slice('custom.'.length), error.message]),
  );
}
