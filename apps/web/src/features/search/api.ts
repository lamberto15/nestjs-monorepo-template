import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const SEARCH_LIMIT = 20;

/** GET /v1/search: the records the caller may read, best matches first. */
export const searchQuery = (q: string, subject?: string) =>
  queryOptions({
    queryKey: ['search', q, subject ?? null] as const,
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/search', {
            params: {
              query: { q, limit: SEARCH_LIMIT, ...(subject && { subject }) },
            },
          }),
        )
      ).items,
    staleTime: 30_000,
  });

export type SearchHit = GetResponse<'/v1/search'>['items'][number];

/**
 * The hits grouped by subject, in the order of the best hit of each. A
 * group is named as the API names its subject, in the request's language.
 */
export function groupBySubject(hits: readonly SearchHit[]) {
  const groups = new Map<
    string,
    { subject: string; label: string; items: SearchHit[] }
  >();
  for (const hit of hits) {
    const group = groups.get(hit.subject);
    if (group) {
      group.items.push(hit);
    } else {
      groups.set(hit.subject, {
        subject: hit.subject,
        label: hit.subjectLabel.plural,
        items: [hit],
      });
    }
  }
  return [...groups.values()];
}
