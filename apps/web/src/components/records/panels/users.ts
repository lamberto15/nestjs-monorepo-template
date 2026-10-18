import { unwrap } from '@nestjs-monorepo-template/api-client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A person a comment can mention: their key (`user:<id>`) and name. */
export type Person = { key: string; name: string };

/** The longest `q` the route takes (a longer one is a 400). */
const MAX_TERM = 100;

/**
 * The tenant's active members whose name contains `term`, by name
 * (`GET /v1/people?q=`, docs/comments.md): open to every member, for the
 * @mention autocomplete. An empty term asks for the first ones by name (the
 * route refuses an empty `q`, so none is sent). The previous answer stays
 * while the next loads, so the list doesn't empty under the user's typing.
 */
export function usePeople(term: string) {
  const q = term.trim().slice(0, MAX_TERM);
  return useQuery({
    queryKey: ['people', q],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/people', { params: { query: q ? { q } : {} } }),
        )
      ).items,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
