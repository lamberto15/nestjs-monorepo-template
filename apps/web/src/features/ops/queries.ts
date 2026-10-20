import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import type { Me } from '@/lib/session';
import type { OpsOutbox, QueueOverview } from './types';

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
  queryFn: () => unwrap<OpsOutbox>(api.GET('/v1/ops/outbox')),
  refetchInterval: REFRESH_MS,
  retry: false,
  // The panel shows the error itself.
  meta: { errorToast: false },
});

export const opsQueuesQuery = queryOptions({
  queryKey: ['ops', 'queues'],
  queryFn: () => unwrap<{ items: QueueOverview[] }>(api.GET('/v1/ops/queues')),
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
      unwrap<{ retried: number }>(
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
      unwrap<{ requeued: number }>(
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
      unwrap<{ purged: number }>(
        api.POST('/v1/ops/dead-letters/purge', { body: ids ? { ids } : {} }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: opsOutboxQuery.queryKey }),
  });
}
