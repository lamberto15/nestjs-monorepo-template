import {
  hasOptions,
  isTextual,
  type CustomField,
  type CustomFieldChanges,
  type CustomFieldCreate,
  type CustomFieldType,
} from '@/lib/custom-fields';
import { toDraft, valueOf, type CustomDraft } from '@/lib/custom-values';

/** The API's key rule (`CUSTOM_KEY_PATTERN`): a slug, never changed. */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
export const LIMITS = {
  label: 120,
  description: 500,
  option: 100,
  optionLabel: 200,
  pattern: 200,
};

export const FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'boolean',
  'date',
  'select',
  'multiSelect',
  'email',
  'url',
] as const satisfies readonly CustomFieldType[];

export type OptionRow = { value: string; label: string };

/** What the definition form holds: texts, so a half-typed number stays typed. */
export type DefinitionValues = {
  key: string;
  label: string;
  description: string;
  type: CustomFieldType;
  options: OptionRow[];
  required: boolean;
  filterable: boolean;
  sortable: boolean;
  default: CustomDraft;
  min: string;
  max: string;
  minLength: string;
  maxLength: string;
  pattern: string;
};

export const EMPTY_DEFINITION: DefinitionValues = {
  key: '',
  label: '',
  description: '',
  type: 'text',
  options: [],
  required: false,
  filterable: false,
  sortable: false,
  default: undefined,
  min: '',
  max: '',
  minLength: '',
  maxLength: '',
  pattern: '',
};

const text = (value: number | undefined) =>
  value === undefined ? '' : String(value);

export function toValues(field: CustomField): DefinitionValues {
  const rules = field.validation ?? {};
  return {
    key: field.key,
    label: field.label,
    description: field.description ?? '',
    type: field.type,
    options: (field.options ?? []).map(({ value, label }) => ({
      value,
      label,
    })),
    required: field.required,
    filterable: field.filterable,
    sortable: field.sortable,
    default: toDraft(field, field.default),
    min: text(rules.min),
    max: text(rules.max),
    minLength: text(rules.minLength),
    maxLength: text(rules.maxLength),
    pattern: rules.pattern ?? '',
  };
}

/** Which limits a type takes (docs/custom-fields.md, the types table). */
export function limitsOf(type: CustomFieldType) {
  return {
    range: type === 'number' || type === 'multiSelect',
    length: isTextual(type),
  };
}

function number(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value);
}

/** The `validation` the type takes, from the form's texts; undefined: none. */
export function validationOf(values: DefinitionValues) {
  const { range, length } = limitsOf(values.type);
  const rules: NonNullable<CustomFieldCreate['validation']> = {};
  if (range) {
    const min = number(values.min);
    const max = number(values.max);
    if (min !== undefined) rules.min = min;
    if (max !== undefined) rules.max = max;
  }
  if (length) {
    const minLength = number(values.minLength);
    const maxLength = number(values.maxLength);
    if (minLength !== undefined) rules.minLength = minLength;
    if (maxLength !== undefined) rules.maxLength = maxLength;
    if (values.pattern.trim() !== '') rules.pattern = values.pattern;
  }
  return Object.keys(rules).length > 0 ? rules : undefined;
}

/** A field as the form describes it, to reuse the record inputs for the default. */
export function previewField(values: DefinitionValues): CustomField {
  return {
    id: 'preview',
    subject: '',
    key: 'default',
    label: '',
    description: null,
    type: values.type,
    options: hasOptions(values.type) ? values.options : null,
    required: false,
    default: null,
    validation: validationOf(values) ?? null,
    position: 0,
    filterable: false,
    sortable: false,
    active: true,
    createdAt: '',
    updatedAt: '',
  };
}

const optionsOf = (values: DefinitionValues) =>
  values.options.map(({ value, label }) => ({
    value: value.trim(),
    label: label.trim(),
  }));

/** POST /v1/custom-fields: only what the type takes. */
export function createBody(
  subject: string,
  values: DefinitionValues,
): CustomFieldCreate {
  const body: CustomFieldCreate = {
    subject,
    key: values.key,
    label: values.label.trim(),
    type: values.type,
    required: values.required,
    filterable: values.filterable,
    sortable: values.sortable,
  };
  if (values.description.trim()) body.description = values.description.trim();
  if (hasOptions(values.type)) body.options = optionsOf(values);
  const fallback = valueOf(previewField(values), values.default);
  if (fallback !== undefined) body.default = fallback;
  const validation = validationOf(values);
  if (validation) body.validation = validation;
  return body;
}

/**
 * PATCH /v1/custom-fields/{id}: only what changed. `null` clears a
 * description, options, a default or the limits.
 */
export function changesBody(
  field: CustomField,
  values: DefinitionValues,
): CustomFieldChanges {
  const before = toValues(field);
  const changes: CustomFieldChanges = {};
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const typeChanged = values.type !== before.type;
  if (values.label.trim() !== before.label) changes.label = values.label.trim();
  if (values.description.trim() !== before.description) {
    changes.description = values.description.trim() || null;
  }
  if (typeChanged) changes.type = values.type;
  if (values.required !== before.required) changes.required = values.required;
  if (values.filterable !== before.filterable) {
    changes.filterable = values.filterable;
  }
  if (values.sortable !== before.sortable) changes.sortable = values.sortable;
  if (hasOptions(values.type)) {
    const options = optionsOf(values);
    if (typeChanged || !same(options, before.options)) {
      changes.options = options;
    }
  } else if (field.options) {
    changes.options = null;
  }
  const fallback = valueOf(previewField(values), values.default);
  const was = valueOf(previewField(before), before.default);
  if (typeChanged || !same(fallback ?? null, was ?? null)) {
    changes.default = fallback ?? null;
  }
  const validation = validationOf(values) ?? null;
  if (!same(validation, validationOf(before) ?? null)) {
    changes.validation = validation;
  }
  return changes;
}
