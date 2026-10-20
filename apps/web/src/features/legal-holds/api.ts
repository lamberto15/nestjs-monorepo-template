import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';

export type LegalHold = GetResponse<'/v1/legal-holds'>['items'][number];

/** What placing a hold sends: a subject, maybe one record, and the reason. */
export type PlaceHoldBody = paths['/v1/legal-holds']['post'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/** The API's subject rule (`placeLegalHoldSchema`): a Pascal-case word. */
export const SUBJECT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

export const PAGE_SIZE = 25;

export type HoldFilters = {
  /** true: only active holds; false: only released ones; undefined: both. */
  active?: boolean;
  subject?: string;
};

/** Everything of the holds starts with this key. */
export const holdsKey = ['legal-holds'] as const;

/** The holds, newest first, in cursor pages (`GET /v1/legal-holds`). */
export const holdsQuery = (filters: HoldFilters) =>
  infiniteQueryOptions({
    queryKey: [...holdsKey, 'list', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/legal-holds', {
          params: {
            query: {
              limit: PAGE_SIZE,
              ...(pageParam && { cursor: pageParam }),
              ...(filters.active !== undefined && {
                active: filters.active ? 'true' : 'false',
              }),
              ...(filters.subject && { subject: filters.subject }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** One hold (`GET /v1/legal-holds/{id}`). */
export const holdQuery = (id: string) =>
  queryOptions({
    queryKey: [...holdsKey, 'one', id],
    queryFn: () =>
      unwrap(api.GET('/v1/legal-holds/{id}', { params: { path: { id } } })),
  });

// The dialogs show the refusals themselves (a 400 on a field, a 409 for a
// hold released already): the global handler stays quiet.
export function usePlaceHold() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: PlaceHoldBody) =>
      unwrap(api.POST('/v1/legal-holds', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: holdsKey }),
  });
}

export function useReleaseHold() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { id: string; note?: string }) =>
      unwrap(
        api.POST('/v1/legal-holds/{id}/release', {
          params: { path: { id: input.id } },
          body: input.note ? { note: input.note } : {},
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: holdsKey }),
  });
}
