import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { listFilters } from '@/lib/list-query';
import { postMultipart } from '@/lib/upload';

/** An export or import job: progress, then the result (docs/data-transfer.md). */
export type Transfer = GetResponse<'/v1/data/transfers/{id}'>;
export type TransferFormat = NonNullable<
  NonNullable<
    paths['/v1/data/exports']['post']['requestBody']
  >['content']['application/json']['format']
>;

/** `GET /v1/data`: what the caller may export and import. */
export type DataCatalog = GetResponse<'/v1/data'>;

export const catalogQuery = queryOptions({
  queryKey: ['data', 'catalog'],
  queryFn: () => unwrap(api.GET('/v1/data')),
  staleTime: 5 * 60 * 1000,
});

/** Without realtime a running job is asked for this often (ms). */
export const POLL = 1000;

/** A job's poll, given the status last read (useLivePoll's `interval`). */
export type JobPoll = (status: string | undefined) => number;

export const transferQuery = (id: string, poll: JobPoll = () => POLL) =>
  queryOptions({
    queryKey: ['data', 'transfer', id],
    queryFn: () =>
      unwrap(api.GET('/v1/data/transfers/{id}', { params: { path: { id } } })),
    // Polled while the worker has it (`poll`: useLivePoll slows it down
    // while the socket is up, the events do the rest); a finished
    // transfer stays as it is.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed'
        ? false
        : poll(status);
    },
  });

export const isFinished = (transfer: Pick<Transfer, 'status'>) =>
  transfer.status === 'completed' || transfer.status === 'failed';

/**
 * What an export takes of a list's state: the list's own filters (`filter`,
 * the advanced filter as JSON, and `q`, the search). The export has no sort
 * and no field choice (its columns are the exporter's), so those are not sent.
 */
export const exportFilters = listFilters;

export const startExport = (body: {
  name: string;
  format: TransferFormat;
  filters: Record<string, string>;
}) => unwrap(api.POST('/v1/data/exports', { body }));

/** The template link of an import: a file to fill (an attachment). */
export const templateUrl = (name: string, format: TransferFormat) =>
  `/v1/data/imports/${encodeURIComponent(name)}/template?format=${format}`;

/** Starts an import (multipart: `name`, `dryRun`, `file`), with upload progress. */
export function startImport(
  input: { name: string; file: File; dryRun: boolean },
  onProgress: (percent: number) => void,
): Promise<{ id: string; status: 'queued' }> {
  const form = new FormData();
  form.append('name', input.name);
  form.append('dryRun', String(input.dryRun));
  form.append('file', input.file);
  return postMultipart('/v1/data/imports', form, onProgress);
}

// ------------------------------------------------------------------ lists

export type TransferKind = 'export' | 'import';
export type TransferState = Transfer['status'];
export type TransferListItem =
  GetResponse<'/v1/data/transfers'>['items'][number];
export type BulkRun = GetResponse<'/v1/bulk'>['items'][number];

const PAGE = 20;

/** The runs the worker still has. */
const activeJobs = (items: { id: string; status: string }[]) =>
  items.filter((item) => item.status === 'queued' || item.status === 'running');

/** A list's poll: ms for the runs still with the worker (never, with none). */
type ListPoll = (active: { id: string; status: string }[]) => number;
const LIST_POLL: ListPoll = () => 2000;

/**
 * The caller's exports and imports in this tenant, newest first, by cursor
 * (`GET /v1/data/transfers`, docs/data-transfer.md "The list"), of one `kind`
 * and `status` or all. A filtered page may hold fewer than `limit` items, even
 * none, while there is a next one (the API reads a bounded number of entries):
 * the page offers "Show more" until `nextCursor` is null. Polled while one of
 * the shown is still with the worker (`poll`: see useLivePoll).
 */
export const transfersListQuery = (
  kind?: TransferKind,
  status?: TransferState,
  poll: ListPoll = LIST_POLL,
) =>
  infiniteQueryOptions({
    queryKey: ['data', 'transfers', kind ?? 'all', status ?? 'all'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/data/transfers', {
          params: {
            query: {
              limit: PAGE,
              ...(kind && { kind }),
              ...(status && { status }),
              ...(pageParam && { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => {
      const active = activeJobs(
        query.state.data?.pages.flatMap((page) => page.items) ?? [],
      );
      return active.length > 0 ? poll(active) : false;
    },
  });

/** The caller's bulk runs handed to the workers (`GET /v1/bulk`), same paging. */
export const bulkListQuery = (
  status?: TransferState,
  poll: ListPoll = LIST_POLL,
) =>
  infiniteQueryOptions({
    queryKey: ['data', 'bulk-runs', status ?? 'all'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/bulk', {
          params: {
            query: {
              limit: PAGE,
              ...(status && { status }),
              ...(pageParam && { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => {
      const active = activeJobs(
        query.state.data?.pages.flatMap((page) => page.items) ?? [],
      );
      return active.length > 0 ? poll(active) : false;
    },
  });
