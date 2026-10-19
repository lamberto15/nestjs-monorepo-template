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
 * - `team`: the tenant's teams (GET /v1/teams, open to every member), all
 *   of them. Names of the teams a list shows come from the same route, by id
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
  /** The values to pick from (tag, team), or those known by name (principal). */
  options: FilterOption[];
  /** The values are too many to list: the API searches them. */
  search?: OptionSearch;
}

export type RefSources = Partial<Record<string, RefSource>>;

/** The ref kinds this file has a source for. */
export const REF_KINDS = ['tag', 'team', 'principal'] as const;

type Team = ItemOf<'/v1/teams'>;

/** The most teams the picker reads: far past what a tenant has. */
const TEAMS_MAX = 1000;

/** The tenant's teams, for any member. */
export const teamRefsQuery = queryOptions({
  queryKey: ['refs', 'teams'],
  queryFn: async (): Promise<Team[]> => {
    const found: Team[] = [];
    for await (const team of api.items('/v1/teams', { limit: 100 })) {
      found.push(team);
      if (found.length >= TEAMS_MAX) break;
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
  key: ['refs', 'people'],
  // The held keys, named by the lookup (every member may read it).
  useNames: (values) => usePeopleNames(values).name,
  query: (term) => {
    const q = term.trim().slice(0, MAX_TERM);
    return {
      queryKey: ['refs', 'people', q],
      queryFn: async () =>
        (
          await unwrap(
            api.GET('/v1/people', { params: { query: q ? { q } : {} } }),
          )
        ).items.map((person) => ({ label: person.name, value: person.key })),
    };
  },
};

/** Teams as options, a child after its parent; the depth indents the label. */
export function teamOptions(teams: readonly Team[]): FilterOption[] {
  const children = new Map<string | null, Team[]>();
  for (const team of teams) {
    const siblings = children.get(team.parentId) ?? [];
    siblings.push(team);
    children.set(team.parentId, siblings);
  }
  const ids = new Set(teams.map((team) => team.id));
  const options: FilterOption[] = [];
  const visit = (team: Team) => {
    options.push({ label: team.name, value: team.id });
    for (const child of children.get(team.id) ?? []) visit(child);
  };
  // Roots: no parent, or a parent this list doesn't hold.
  for (const team of teams) {
    if (team.parentId === null || !ids.has(team.parentId)) visit(team);
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
  const teams = useQuery({ ...teamRefsQuery, enabled: kinds.has('team') });
  // Who is signed in, as the app already knows it: never fetched from here.
  const me = useQuery({ ...meQuery, enabled: false }).data;

  return useMemo(() => {
    const sources: RefSources = {};
    if (kinds.has('tag')) {
      sources.tag = { options: tagOptions(tags.data ?? []) };
    }
    if (kinds.has('team')) {
      sources.team = { options: teamOptions(teams.data ?? []) };
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
  }, [kinds, tags.data, teams.data, me]);
}

/** A ref value's name, when known; undefined otherwise. */
export function refLabel(
  source: RefSource | undefined,
  value: string,
): string | undefined {
  return source?.options.find((option) => option.value === value)?.label;
}
