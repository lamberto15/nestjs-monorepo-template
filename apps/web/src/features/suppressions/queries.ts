import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';

export type Suppression = GetResponse<'/v1/mail/suppressions'>['items'][number];
export type SuppressionReason = Suppression['reason'];

/** What a create sends: the address and an optional note. */
export type AddSuppressionBody =
  paths['/v1/mail/suppressions']['post'] extends {
    requestBody: { content: { 'application/json': infer B } };
  }
    ? B
    : never;

export const reasons = [
  'hard_bounce',
  'soft_bounce',
  'complaint',
  'manual',
] as const satisfies readonly SuppressionReason[];

/** Which entries: mail is held back (`suppressed`), or only watched for soft bounces. */
export const statuses = ['suppressed', 'watching'] as const;
export type SuppressionStatus = (typeof statuses)[number];

/** The sorts the list offers (the API sorts by address and by the dates). */
export const sorts = ['lastSeen', 'suppressed', 'address'] as const;
export type SuppressionSort = (typeof sorts)[number];
const sortParam: Record<SuppressionSort, string> = {
  lastSeen: '-lastSeenAt',
  suppressed: '-suppressedAt',
  address: 'address',
};

export const PER_PAGE = 20;

export type SuppressionFilters = {
  /** Part of an address (`address.contains`; any case). */
  address?: string;
  reason?: SuppressionReason;
  status?: SuppressionStatus;
  sort?: SuppressionSort;
  page: number;
};

/** Everything of the list starts with this key. */
export const suppressionsKey = ['mail-suppressions'] as const;

/** A page of the suppression list, by number (`GET /v1/mail/suppressions`). */
export const suppressionsQuery = (filters: SuppressionFilters) =>
  queryOptions({
    queryKey: [...suppressionsKey, 'list', filters],
    queryFn: () =>
      unwrap(
        api.GET('/v1/mail/suppressions', {
          params: {
            query: {
              page: filters.page,
              limit: PER_PAGE,
              count: 'true',
              ...(filters.address && { 'address.contains': filters.address }),
              ...(filters.reason && { reason: filters.reason }),
              ...(filters.status && {
                'suppressedAt.isNull':
                  filters.status === 'watching' ? 'true' : 'false',
              }),
              ...(filters.sort && { sort: sortParam[filters.sort] }),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
    // Not the operators' (or no such permission): 403, no point asking again.
    retry: false,
  });

/** One entry (`GET /v1/mail/suppressions/{id}`; 404 once it was removed). */
export const suppressionQuery = (id: string) =>
  queryOptions({
    queryKey: [...suppressionsKey, 'one', id],
    queryFn: () =>
      unwrap(
        api.GET('/v1/mail/suppressions/{id}', { params: { path: { id } } }),
      ),
    retry: false,
  });

/**
 * Stops mail to an address (a `manual` entry). The caller shows the refusals:
 * a 409 when the address is listed already, a 400 for a bad address.
 */
export function useAddSuppression() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: AddSuppressionBody) =>
      unwrap(api.POST('/v1/mail/suppressions', { body })),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: suppressionsKey }),
  });
}

/** Sends mail to the address again: removes its entry. */
export function useRemoveSuppression() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await unwrap(
        api.DELETE('/v1/mail/suppressions/{id}', { params: { path: { id } } }),
      );
    },
    onSuccess: (_data, id) => {
      // Its own query would 404 on a refetch: dropped, then the list.
      queryClient.removeQueries({ queryKey: suppressionQuery(id).queryKey });
      return queryClient.invalidateQueries({ queryKey: suppressionsKey });
    },
  });
}
