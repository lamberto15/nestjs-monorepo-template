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
 * How a value is edited. The API does not describe a setting's type (only
 * `default` and `flag`), so it is read from the default: a boolean (or a
 * flag) is a switch, a number a number input, a string a text input,
 * anything else (null, an object, an array) JSON.
 */
export type Kind = 'boolean' | 'number' | 'string' | 'json';

export function kindOf(setting: Pick<Setting, 'flag' | 'default'>): Kind {
  if (setting.flag) {
    return 'boolean';
  }
  switch (typeof setting.default) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    default:
      return 'json';
  }
}

/** A draft is what the input holds: a boolean, or the text typed. */
export type Draft = boolean | string;

export function toDraft(kind: Kind, value: unknown): Draft {
  switch (kind) {
    case 'boolean':
      return value === true;
    case 'number':
      return typeof value === 'number' ? String(value) : '';
    case 'string':
      return typeof value === 'string' ? value : '';
    default:
      return JSON.stringify(value ?? null, null, 2);
  }
}

export type Parsed = { ok: true; value: unknown } | { ok: false };

export function fromDraft(kind: Kind, draft: Draft): Parsed {
  if (kind === 'boolean') {
    return { ok: true, value: draft === true };
  }
  const text = String(draft);
  if (kind === 'string') {
    return { ok: true, value: text };
  }
  if (kind === 'number') {
    const number = Number(text);
    return text.trim() === '' || !Number.isFinite(number)
      ? { ok: false }
      : { ok: true, value: number };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
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
