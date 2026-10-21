import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  unwrap,
  type GetResponse,
  type operations,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import type { Me } from '@/lib/session';

// The API's answers, as the generated client types them (never by hand).
export type QueueOverview = GetResponse<'/v1/ops/queues'>['items'][number];
export type QueueCounts = QueueOverview['counts'];
/** One message of the live log: a union by `source` (the engine), then `type`. */
export type OpsEventData =
  operations['OpsController_events_v1']['responses'][200]['content']['text/event-stream'];

/** How often the counters are read again while the page is open. */
const REFRESH_MS = 10_000;

/**
 * Who sees the operations page: the API answers `/v1/ops/*` to users acting
 * in the operator tenant (any tenancy) who hold `Ops.view`, so the app asks
 * only then (anyone else would get 403 `operator_required`).
 */
export function canViewOps(me: Me | null | undefined): boolean {
  return me?.tenant?.operator === true && me.can['Ops.view'] === true;
}

export const opsOutboxQuery = queryOptions({
  queryKey: ['ops', 'outbox'],
  queryFn: () => unwrap(api.GET('/v1/ops/outbox')),
  refetchInterval: REFRESH_MS,
  retry: false,
  // The panel shows the error itself.
  meta: { errorToast: false },
});

export const opsQueuesQuery = queryOptions({
  queryKey: ['ops', 'queues'],
  queryFn: () => unwrap(api.GET('/v1/ops/queues')),
  refetchInterval: REFRESH_MS,
  retry: false,
  // The panel shows the error itself.
  meta: { errorToast: false },
});

/** Failed jobs of a queue, run again: how many were put back. */
export function useRetryFailed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      unwrap(
        api.POST('/v1/ops/queues/{name}/retry-failed', {
          params: { path: { name } },
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: opsQueuesQuery.queryKey }),
  });
}

/** Dead letters back to the outbox: these ids, or all of them (no ids). */
export function useRequeueDeadLetters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      unwrap(
        api.POST('/v1/ops/dead-letters/requeue', {
          body: ids ? { ids } : {},
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: opsOutboxQuery.queryKey }),
  });
}

/** Dead letters deleted for good: these ids, or all of them (no ids). */
export function usePurgeDeadLetters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      unwrap(
        api.POST('/v1/ops/dead-letters/purge', { body: ids ? { ids } : {} }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: opsOutboxQuery.queryKey }),
  });
}
