import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { peopleQuery } from '@/lib/people';

/**
 * The tenant's active members whose name contains `term`, by name
 * (`GET /v1/people?q=`, docs/comments.md): open to every member, for the
 * @mention autocomplete. The previous answer stays while the next loads, so
 * the list doesn't empty under the user's typing.
 */
export function usePeople(term: string) {
  return useQuery({ ...peopleQuery(term), placeholderData: keepPreviousData });
}
