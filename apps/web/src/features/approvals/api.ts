import {
  etagOf,
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

export type ApprovalItem = GetResponse<'/v1/approvals'>['items'][number];
export type Approval = GetResponse<'/v1/approvals/{id}'>;
export type ApprovalStatus = Approval['status'];
export type Delegation =
  GetResponse<'/v1/approvals/delegations'>['items'][number];
export type DelegationBody = NonNullable<
  paths['/v1/approvals/delegations']['post']['requestBody']
>['content']['application/json'];

/** Every approvals query starts with this key: one invalidation covers all. */
export const approvalsKey = ['approvals'] as const;

export const tabs = ['mine', 'requested', 'history'] as const;
export type Tab = (typeof tabs)[number];

/** What each inbox tab asks the API for (docs/approvals.md, "The API"). */
function tabFilter(tab: Tab): Record<string, string> {
  switch (tab) {
    case 'mine':
      return { assignedToMe: 'true' };
    case 'requested':
      return { requestedByMe: 'true' };
    // What the user decided, themselves or standing in for someone.
    case 'history':
      return { decidedByMe: 'true' };
  }
}

export const PAGE_SIZE = 20;

/** One tab's requests, cursor pages, the newest first. */
export const inboxQuery = (tab: Tab, poll: number | false) =>
  infiniteQueryOptions({
    queryKey: [...approvalsKey, 'list', tab],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/approvals', {
          params: {
            query: {
              limit: String(PAGE_SIZE),
              ...(pageParam && { cursor: pageParam }),
              ...tabFilter(tab),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: poll,
  });

/** The nav badge: how many requests wait for the user (`total` of a one-row page). */
export const pendingCountQuery = (poll: number | false) =>
  queryOptions({
    queryKey: [...approvalsKey, 'count'],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/approvals', {
            params: {
              query: {
                assignedToMe: 'true',
                limit: '1',
                page: '1',
                count: 'true',
              },
            },
          }),
        )
      ).total ?? 0,
    refetchInterval: poll,
    // The badge is a hint: a failure is not worth a toast.
    meta: { errorToast: false },
  });

/** One request with its ETag (the `If-Match` of a decision). */
export const approvalQuery = (id: string) =>
  queryOptions({
    queryKey: [...approvalsKey, 'detail', id],
    queryFn: async () => {
      const result = await api.GET('/v1/approvals/{id}', {
        params: { path: { id } },
      });
      return {
        approval: await unwrap(Promise.resolve(result)),
        etag: etagOf(result),
      };
    },
  });

/** The open request of one record (a banner on its page), if the user may see it. */
export const recordApprovalQuery = (subject: string, recordId: string) =>
  queryOptions({
    queryKey: [...approvalsKey, 'record', subject, recordId],
    queryFn: async () => {
      const page = await unwrap(
        api.GET('/v1/approvals', {
          params: {
            query: {
              subject,
              recordId,
              'status.in': 'pending,changes_requested',
              limit: '1',
            },
          },
        }),
      );
      return page.items[0]?.id ?? null;
    },
    meta: { errorToast: false },
  });

export const delegationsQuery = queryOptions({
  queryKey: [...approvalsKey, 'delegations'],
  queryFn: async () =>
    (await unwrap(api.GET('/v1/approvals/delegations'))).items,
});

export type Decision = 'approve' | 'reject' | 'cancel';

/**
 * A decision on a request. `etag` makes it refuse (412) when the request
 * changed since it was read. Afterwards every approval query is refreshed,
 * and the records (an approved note is published).
 */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: {
      id: string;
      decision: Decision;
      comment?: string;
      etag?: string;
    }) => {
      const params = {
        path: { id: input.id },
        ...(input.etag && { header: { 'If-Match': input.etag } }),
      };
      const comment = input.comment?.trim() || undefined;
      switch (input.decision) {
        case 'approve':
          return unwrap(
            api.POST('/v1/approvals/{id}/approve', {
              params,
              body: { ...(comment && { comment }) },
            }),
          );
        case 'reject':
          return unwrap(
            api.POST('/v1/approvals/{id}/reject', {
              params,
              body: { comment: comment ?? '' },
            }),
          );
        case 'cancel':
          return unwrap(
            api.POST('/v1/approvals/{id}/cancel', {
              params,
              body: { ...(comment && { reason: comment }) },
            }),
          );
      }
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: approvalsKey }),
        queryClient.invalidateQueries({ queryKey: ['record'] }),
        queryClient.invalidateQueries({ queryKey: ['list'] }),
      ]),
  });
}

export function useCreateDelegation() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: DelegationBody) =>
      unwrap(api.POST('/v1/approvals/delegations', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: approvalsKey }),
  });
}

export function useEndDelegation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE('/v1/approvals/delegations/{id}', {
          params: { path: { id } },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: approvalsKey }),
  });
}
