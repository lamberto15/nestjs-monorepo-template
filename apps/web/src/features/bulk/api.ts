import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A feature's bulk route (`/v1/<plural>/bulk`): the same shape under every path. */
export type BulkPath = Extract<keyof paths, `/v1/${string}/bulk`>;
export type BulkAction = 'delete' | 'restore' | 'update';

/** What a run acts on: these records, or every record a list filter matches. */
export type BulkSelection =
  { ids: string[] } | { filter: Record<string, string> };

export interface BulkBody {
  action: BulkAction;
  selection: BulkSelection;
  input?: Record<string, unknown>;
}

export type BulkResult = NonNullable<GetResponse<'/v1/bulk/{id}'>['result']>;
export type BulkJob = GetResponse<'/v1/bulk/{id}'>;

/** At most this many ids in one run; more is a `filter` run (docs/bulk-operations.md). */
export const MAX_BULK_IDS = 500;

export type BulkOutcome =
  { kind: 'done'; result: BulkResult } | { kind: 'job'; id: string };

/**
 * `POST /v1/<x>/bulk`. Up to 100 ids answer at once (200, a result per id);
 * more, and every `filter` run, are a job (202). The client sends the
 * Idempotency-Key the route requires.
 */
export async function runBulk(
  path: BulkPath,
  { action, selection, input }: BulkBody,
): Promise<BulkOutcome> {
  type Answer = BulkResult | { id: string; status: 'queued' };
  // openapi-fetch types its body per path; this one is generic over paths.
  const post = api.POST as unknown as (
    path: string,
    init: { body: unknown },
  ) => Promise<{ data?: Answer; response: Response }>;
  const data = await unwrap(
    post(path, {
      body: { action, ...selection, ...(input && { input }) },
    }),
  );
  return 'results' in data
    ? { kind: 'done', result: data }
    : { kind: 'job', id: data.id };
}

export const bulkJobQuery = (id: string) =>
  queryOptions({
    queryKey: ['bulk', id],
    queryFn: () =>
      unwrap(api.GET('/v1/bulk/{id}', { params: { path: { id } } })),
    // Progress is reported every 100 items.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 1000;
    },
  });
