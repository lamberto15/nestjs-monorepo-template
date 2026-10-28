import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  unwrap,
  type GetResponse,
  type operations,
  type paths,
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

/** One queue paused (every worker stops taking its jobs) or resumed. */
export function usePauseQueue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, paused }: { name: string; paused: boolean }) =>
      unwrap(
        paused
          ? api.POST('/v1/ops/queues/{name}/pause', {
              params: { path: { name } },
            })
          : api.POST('/v1/ops/queues/{name}/resume', {
              params: { path: { name } },
            }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: opsQueuesQuery.queryKey }),
  });
}

/** Which backlog: one tenant's, or every tenant's (global), narrowed by type, mail class, age. */
export type BacklogScope =
  paths['/v1/ops/backlog/preview']['post']['requestBody']['content']['application/json'];
export type BacklogTarget = 'outbox' | 'mail';

/** The dry run: the backlog in scope, counted (changes nothing). */
export function useBacklogPreview() {
  return useMutation({
    mutationFn: (scope: BacklogScope) =>
      unwrap(api.POST('/v1/ops/backlog/preview', { body: scope })),
    // The panel shows the error itself.
    meta: { errorToast: false },
  });
}

/**
 * Discards or retries the backlog in scope: the API does at most 10,000 a
 * call and says `more`, so this calls again until it is done. Returns the
 * total.
 */
export function useBacklogAction(action: 'discard' | 'retry') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      target: BacklogTarget;
      scope: BacklogScope;
    }) => {
      let total = 0;
      for (;;) {
        const { count, more } = await unwrap(
          action === 'discard'
            ? api.POST('/v1/ops/backlog/discard', { body: input })
            : api.POST('/v1/ops/backlog/retry', { body: input }),
        );
        total += count;
        if (!more || count === 0) return total;
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['ops'] }),
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

export type Diagnostic = GetResponse<'/v1/ops/diagnostics'>['items'][number];

export const opsDiagnosticsQuery = queryOptions({
  queryKey: ['ops', 'diagnostics'],
  queryFn: () => unwrap(api.GET('/v1/ops/diagnostics')),
  retry: false,
  // The panel shows the error itself.
  meta: { errorToast: false },
});

/** A safe connection test of one integration: its result, never a thrown failure. */
export function useTestDiagnostic() {
  return useMutation({
    mutationFn: (check: Diagnostic['check']) =>
      unwrap(
        api.POST('/v1/ops/diagnostics/{check}/test', {
          params: { path: { check } },
        }),
      ),
  });
}
