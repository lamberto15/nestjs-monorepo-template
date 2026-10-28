import {
  etagOf,
  filterParam,
  unwrap,
  type Filter,
} from '@nestjs-monorepo-template/api-client';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { api } from '@/lib/api';
import type { ListDescription } from '@/lib/list-query';

/** What a list can be shown as: the table, and the views a subject declares. */
export type ViewKind = 'table' | 'board' | 'calendar' | 'timeline';
export type RecordViews = NonNullable<ListDescription['views']>;

const KINDS: ViewKind[] = ['table', 'board', 'calendar', 'timeline'];

/** The kinds this list offers: the table, then each declared view. */
export function viewKinds(views: ListDescription['views']): ViewKind[] {
  return KINDS.filter((kind) => kind === 'table' || views?.[kind]);
}

/** The shown kind, in the URL (`?layout=board`; `?view=` is a saved view's); the table without it or when the list offers no such view. */
export function useViewKind(kinds: ViewKind[]) {
  const [kind, setKind] = useQueryState(
    'layout',
    parseAsStringEnum<ViewKind>(KINDS)
      .withDefault('table')
      .withOptions({ clearOnDefault: true }),
  );
  return [
    kinds.includes(kind) ? kind : 'table',
    (next: ViewKind) => void setKind(next),
  ] as const;
}

/**
 * The list's own `filter` (the table's filters; `q` stays beside it) and these
 * conditions, all of which must hold: how a view bounds the list the user
 * has filtered.
 */
export function withConditions(
  base: Record<string, string>,
  conditions: Filter[],
): Record<string, string> {
  const user = base.filter ? (JSON.parse(base.filter) as Filter) : undefined;
  // The table's `and` group joins ours rather than nesting in it: the list
  // refuses filters nested deeper than `limits.maxDepth`.
  const theirs = user ? ('and' in user ? user.and : [user]) : [];
  return {
    ...base,
    filter: filterParam({ and: [...conditions, ...theirs] }),
  };
}

/** The fields a view asks for: the table's visible ones, and what the view itself reads. */
export function withFields(
  params: Record<string, string>,
  own: string[],
  description: ListDescription,
): string {
  const selectable = new Set(description.select);
  return [
    ...new Set([
      ...(params.fields?.split(',') ?? []),
      ...own.filter((name) => selectable.has(name)),
    ]),
  ].join(',');
}

type Call = (
  path: string,
  init: {
    params: { path: { id: string }; header?: { 'If-Match': string } };
    body?: unknown;
  },
) => Promise<{ data?: unknown; response: Response }>;

/**
 * Changes one field of a record through its normal update route: reads the
 * record for its ETag, then `PATCH`es with `If-Match`, so the record's
 * permissions, validations and the 412 for a record changed meanwhile all
 * apply. Resolves to whether the field took the value: the update can
 * answer without changing it (a field it does not change, or a change that
 * waits for approval), which the caller rolls back like a refusal.
 */
export async function changeField(
  path: string,
  id: string,
  field: string,
  value: string,
) {
  const route = `${path}/{id}`;
  const read = await (api.GET as unknown as Call)(route, {
    params: { path: { id } },
  });
  const etag = etagOf(read);
  await unwrap(Promise.resolve(read));
  const saved = await unwrap(
    (api.PATCH as unknown as Call)(route, {
      params: { path: { id }, ...(etag && { header: { 'If-Match': etag } }) },
      body: { [field]: value },
    }),
  );
  return (saved as Record<string, unknown> | undefined)?.[field] === value;
}
