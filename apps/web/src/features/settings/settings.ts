import type { GetResponse } from '@nestjs-monorepo-template/api-client';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type Setting = GetResponse<'/v1/settings'>['items'][number];
export type Override =
  GetResponse<'/v1/settings/{key}/overrides'>['items'][number];
export type Scope = 'tenant' | 'team' | 'user';

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: async () => (await unwrap(api.GET('/v1/settings'))).items,
});

export const overridesQuery = (key: string) =>
  queryOptions({
    queryKey: ['settings', key, 'overrides'],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/settings/{key}/overrides', {
            params: { path: { key } },
          }),
        )
      ).items,
  });

/**
 * How a value is edited: the setting's declared `type` (docs/settings.md,
 * "What a setting describes"). A boolean (a flag) is a switch, an enum a
 * select of its `options`, a number a number input within `min`/`max`, a
 * string a text input up to `maxLength`; `json` (an object, a union) JSON.
 */
export type Kind = Setting['type'];

/** What the input and the checks need of a setting. */
export type ValueSpec = Pick<
  Setting,
  'type' | 'options' | 'min' | 'max' | 'integer' | 'maxLength'
>;

/** A draft is what the input holds: a boolean, or the text typed or picked. */
export type Draft = boolean | string;

export function toDraft(spec: ValueSpec, value: unknown): Draft {
  switch (spec.type) {
    case 'boolean':
      return value === true;
    case 'number':
      return typeof value === 'number' ? String(value) : '';
    case 'string':
      return typeof value === 'string' ? value : '';
    case 'enum':
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    default:
      return JSON.stringify(value ?? null, null, 2);
  }
}

/** Why a draft is refused: the `invalid.*` text to show, with its values. */
export type Invalid = {
  reason:
    | 'boolean'
    | 'number'
    | 'integer'
    | 'min'
    | 'max'
    | 'string'
    | 'maxLength'
    | 'enum'
    | 'json';
  limit?: number;
};

export type Parsed =
  { ok: true; value: unknown } | { ok: false; invalid: Invalid };

const refuse = (reason: Invalid['reason'], limit?: number): Parsed => ({
  ok: false,
  invalid: limit === undefined ? { reason } : { reason, limit },
});

/**
 * The value of a draft, checked against what the setting declares. The API
 * checks again on PUT (its JSON Schema says more: patterns, refinements):
 * this only spares a round trip for what the form can tell.
 */
export function fromDraft(spec: ValueSpec, draft: Draft): Parsed {
  if (spec.type === 'boolean') {
    return { ok: true, value: draft === true };
  }
  const text = String(draft);
  switch (spec.type) {
    case 'string':
      return spec.maxLength !== undefined && text.length > spec.maxLength
        ? refuse('maxLength', spec.maxLength)
        : { ok: true, value: text };
    case 'enum': {
      // Options may be numbers: the draft is their text, the value theirs.
      const option = spec.options?.find((o) => String(o) === text);
      return option === undefined
        ? refuse('enum')
        : { ok: true, value: option };
    }
    case 'number': {
      const number = Number(text);
      if (text.trim() === '' || !Number.isFinite(number)) {
        return refuse('number');
      }
      if (spec.integer && !Number.isInteger(number)) {
        return refuse('integer');
      }
      if (spec.min !== undefined && number < spec.min) {
        return refuse('min', spec.min);
      }
      if (spec.max !== undefined && number > spec.max) {
        return refuse('max', spec.max);
      }
      return { ok: true, value: number };
    }
    default:
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return refuse('json');
      }
  }
}

/** `notes.publishDelay` belongs to the group `notes`. */
export function groupOf(key: string): string {
  return key.split('.')[0] ?? key;
}

/** Keys that match a search text (key, label or description). */
export function matches(setting: Setting, search: string): boolean {
  const needle = search.trim().toLowerCase();
  return (
    !needle ||
    [setting.key, setting.label, setting.description ?? ''].some((text) =>
      text.toLowerCase().includes(needle),
    )
  );
}

/** The `PUT /v1/settings/{key}` body for a scope (none for the tenant's id). */
export function overrideBody(input: {
  scope: Scope;
  scopeId: string;
  value?: unknown;
  rollout?: number;
}) {
  return {
    scope: input.scope,
    ...(input.scope === 'tenant' ? {} : { scopeId: input.scopeId }),
    ...(input.rollout === undefined
      ? { value: input.value }
      : { rollout: input.rollout }),
  };
}
