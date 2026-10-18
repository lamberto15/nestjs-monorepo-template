import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A member of the tenant as `GET /v1/people` gives them: their key
 * (`user:<id>`) and name, nothing else. Unlike `GET /v1/access/principals`
 * (lib/principals.ts), every member may read it: what pickers for ordinary
 * users search (an @mention, a delegate).
 */
export type Person = GetResponse<'/v1/people'>['items'][number];

/** The longest `q` the route takes (a longer one is a 400). */
const MAX_TERM = 100;

/** The user id in a person's key (`user:<id>`). */
export function personUserId(key: string): string {
  return key.startsWith('user:') ? key.slice('user:'.length) : key;
}

/**
 * The active members whose name contains `term`, by name. An empty term asks
 * for the first ones by name (the route refuses an empty `q`, so none is sent).
 */
export function peopleQuery(term: string) {
  const q = term.trim().slice(0, MAX_TERM);
  return queryOptions({
    queryKey: ['people', q],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/people', { params: { query: q ? { q } : {} } }),
        )
      ).items,
    staleTime: 60_000,
  });
}
