import { unwrap, type ItemOf } from '@nestjs-monorepo-template/api-client';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import type { FilterOption, OptionSearch } from '@/lib/data-table-types';
import type { ListField } from '@/lib/list-query';
import { usePeopleNames } from '@/lib/people';
import { meQuery } from '@/lib/session';
import { tagOptions, useTags } from '@/lib/tags';

/**
 * What a list's reference fields point at (`ref` in GET /v1/lists/{subject},
 * docs/api-conventions.md, "References"), so their filter is a picker and
 * their cells show names, for any feature's list:
 *
 * - `tag`: the subject's tags (GET /v1/tags), all of them.
 * - `unit`: the tenant's units (GET /v1/organizational-units, open to every member), all
 *   of them. Names of the units a list shows come from the same route, by id
 *   (lib/people.ts).
 * - `principal`: users, searched by name as one types (GET /v1/people, open
 *   to every member; values `user:<id>`). Names of values already held (a
 *   filter's chips, a column's cells) come from the lookup by key, batched
 *   (lib/people.ts).
 *
 * Any other `ref` (a record's subject) has no source: its filter stays the
 * field's own (a text box taking the id).
 */
export interface RefSource {
  /** The values to pick from (tag, unit), or those known by name (principal). */
  options: FilterOption[];
  /** The values are too many to list: the API searches them. */
  search?: OptionSearch;
}

export type RefSources = Partial<Record<string, RefSource>>;

/** The ref kinds this file has a source for. */
export const REF_KINDS = ['tag', 'unit', 'principal'] as const;

type Unit = ItemOf<'/v1/organizational-units'>;

/** The most units the picker reads: far past what a tenant has. */
const UNITS_MAX = 1000;

/**
 * The root of the filters' option lists (units, people): a change to either
 * invalidates it, from wherever that happens.
 */
export const refsKey = ['refs'] as const;

/** The tenant's units, for any member. */
export const unitRefsQuery = queryOptions({
  queryKey: [...refsKey, 'units'],
  queryFn: async (): Promise<Unit[]> => {
    const found: Unit[] = [];
    for await (const unit of api.items('/v1/organizational-units', {
      limit: 100,
    })) {
      found.push(unit);
      if (found.length >= UNITS_MAX) break;
    }
    return found;
  },
  staleTime: 10 * 60 * 1000,
  retry: false,
  meta: { errorToast: false },
});

/** The longest `q` GET /v1/people takes (a longer one is a 400). */
const MAX_TERM = 100;

/** Users by name, as a picker's options: the key is the value. */
export const peopleSearch: OptionSearch = {
  key: [...refsKey, 'people'],
  // The held keys, named by the lookup (every member may read it).
  useNames: (values) => usePeopleNames(values).name,
  query: (term) => {
    const q = term.trim().slice(0, MAX_TERM);
    return {
      queryKey: [...refsKey, 'people', q],
      queryFn: async () =>
        (
          await unwrap(
            api.GET('/v1/people', { params: { query: q ? { q } : {} } }),
          )
        ).items.map((person) => ({ label: person.name, value: person.key })),
    };
  },
};

/** Units as options, a child after its parent; the depth indents the label. */
export function unitOptions(units: readonly Unit[]): FilterOption[] {
  const children = new Map<string | null, Unit[]>();
  for (const unit of units) {
    const siblings = children.get(unit.parentId) ?? [];
    siblings.push(unit);
    children.set(unit.parentId, siblings);
  }
  const ids = new Set(units.map((unit) => unit.id));
  const options: FilterOption[] = [];
  const visit = (unit: Unit) => {
    options.push({ label: unit.name, value: unit.id });
    for (const child of children.get(unit.id) ?? []) visit(child);
  };
  // Roots: no parent, or a parent this list doesn't hold.
  for (const unit of units) {
    if (unit.parentId === null || !ids.has(unit.parentId)) visit(unit);
  }
  return options;
}

/** The ref kinds a list's fields point at that have a source here. */
export function refKinds(fields: readonly ListField[]): Set<string> {
  return new Set(
    fields.flatMap((field) =>
      field.ref && (REF_KINDS as readonly string[]).includes(field.ref)
        ? [field.ref]
        : [],
    ),
  );
}

/** The sources of the refs a list's fields point at (only those are fetched). */
export function useListRefs(
  subject: string,
  fields: readonly ListField[],
): RefSources {
  const kinds = useMemo(() => refKinds(fields), [fields]);
  const tags = useTags(subject, kinds.has('tag'));
  const units = useQuery({ ...unitRefsQuery, enabled: kinds.has('unit') });
  // Who is signed in, as the app already knows it: never fetched from here.
  const me = useQuery({ ...meQuery, enabled: false }).data;

  return useMemo(() => {
    const sources: RefSources = {};
    if (kinds.has('tag')) {
      sources.tag = { options: tagOptions(tags.data ?? []) };
    }
    if (kinds.has('unit')) {
      sources.unit = { options: unitOptions(units.data ?? []) };
    }
    if (kinds.has('principal')) {
      sources.principal = {
        options: me?.user
          ? [{ label: me.user.name, value: `user:${me.user.id}` }]
          : [],
        search: peopleSearch,
      };
    }
    return sources;
  }, [kinds, tags.data, units.data, me]);
}
