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

export const transferQuery = (id: string) =>
  queryOptions({
    queryKey: ['data', 'transfer', id],
    queryFn: () =>
      unwrap(api.GET('/v1/data/transfers/{id}', { params: { path: { id } } })),
    // Polled while the worker has it (the realtime events are not needed for
    // one job on screen); a finished transfer stays as it is.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 1000;
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
export type TransferListItem =
  GetResponse<'/v1/data/transfers'>['items'][number];
export type BulkRun = GetResponse<'/v1/bulk'>['items'][number];

const PAGE = 20;

const active = (items: { status: string }[]) =>
  items.some((item) => item.status === 'queued' || item.status === 'running');

/**
 * The caller's exports and imports in this tenant, newest first, by cursor
 * (`GET /v1/data/transfers`, docs/data-transfer.md "The list"). Polled while
 * one of the shown is still with the worker.
 */
export const transfersListQuery = (kind?: TransferKind) =>
  infiniteQueryOptions({
    queryKey: ['data', 'transfers', kind ?? 'all'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/data/transfers', {
          params: {
            query: {
              limit: PAGE,
              ...(kind && { kind }),
              ...(pageParam && { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      active(query.state.data?.pages.flatMap((page) => page.items) ?? [])
        ? 2000
        : false,
  });

/** The caller's bulk runs handed to the workers (`GET /v1/bulk`), same paging. */
export const bulkListQuery = infiniteQueryOptions({
  queryKey: ['data', 'bulk-runs'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/v1/bulk', {
        params: {
          query: { limit: PAGE, ...(pageParam && { cursor: pageParam }) },
        },
      }),
    ),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  refetchInterval: (query) =>
    active(query.state.data?.pages.flatMap((page) => page.items) ?? [])
      ? 2000
      : false,
});
