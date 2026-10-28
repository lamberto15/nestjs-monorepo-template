import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import {
  infiniteQueryOptions,
  queryOptions,
  useQuery,
} from '@tanstack/react-query';
import { api } from '@/lib/api';
import { postMultipart } from '@/lib/upload';

/** An export or import job: progress, then the result (docs/data-transfer.md). */
export type Transfer = GetResponse<'/v1/data/transfers/{id}'>;
export type TransferFormat = NonNullable<
  NonNullable<
    paths['/v1/data/exports']['post']['requestBody']
  >['content']['application/json']['format']
>;

export const catalogQuery = queryOptions({
  queryKey: ['data', 'catalog'],
  queryFn: () => unwrap(api.GET('/v1/data')),
  staleTime: 5 * 60 * 1000,
});

/** Without realtime a running job is asked for this often (ms). */
export const POLL = 1000;

/** A job's poll, given the status last read (useLivePoll's `interval`). */
export type JobPoll = (status: string | undefined) => number | false;

export const transferQuery = (id: string, poll: JobPoll = () => POLL) =>
  queryOptions({
    queryKey: ['data', 'transfer', id],
    queryFn: () =>
      unwrap(api.GET('/v1/data/transfers/{id}', { params: { path: { id } } })),
    // Polled while the worker has it (`poll`: useLivePoll stops it while
    // the socket is up, the events do the rest); a finished
    // transfer stays as it is.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed'
        ? false
        : poll(status);
    },
  });

/**
 * The export of a subject's list, if the caller may run one (`GET /v1/data`
 * names each export's `subject`): what a list page offers by default.
 */
export function useExporterFor(subject: string) {
  const catalog = useQuery({ ...catalogQuery, meta: { errorToast: false } });
  return catalog.data?.exports.find((e) => e.subject === subject)?.name;
}

export const startExport = (body: {
  name: string;
  format: TransferFormat;
  /** The list's filter, search and scope (`listExport()`). */
  filters: Record<string, string>;
  /** The list's sort, so the file is in the order shown. */
  sort?: string;
}) => unwrap(api.POST('/v1/data/exports', { body }));

/** The template link of an import: a file to fill (an attachment). */
export const templateUrl = (name: string, format: TransferFormat) =>
  `/v1/data/imports/${encodeURIComponent(name)}/template?format=${format}`;

/** A file's headers to the template's columns (null: ignore the column). */
export type ImportMapping = Record<string, string | null>;

/** Starts an import (multipart: `name`, `dryRun`, `mapping`, `file`), with upload progress. */
export function startImport(
  input: {
    name: string;
    file: File;
    dryRun: boolean;
    matchOn?: string;
    mapping?: ImportMapping;
  },
  onProgress: (percent: number) => void,
): Promise<{ id: string; status: 'queued' }> {
  const form = new FormData();
  form.append('name', input.name);
  form.append('dryRun', String(input.dryRun));
  if (input.matchOn) form.append('matchOn', input.matchOn);
  // Fields before the file: the server reads them when the file arrives.
  if (input.mapping && Object.keys(input.mapping).length > 0) {
    form.append('mapping', JSON.stringify(input.mapping));
  }
  form.append('file', input.file);
  return postMultipart('/v1/data/imports', form, onProgress);
}

/** An import's saved column mappings (the tenant's). */
export const mappingsQuery = (name: string) =>
  queryOptions({
    queryKey: ['data', 'mappings', name],
    queryFn: () =>
      unwrap(
        api.GET('/v1/data/imports/{name}/mappings', {
          params: { path: { name } },
        }),
      ),
  });

export const saveMapping = (
  name: string,
  body: { name: string; mapping: ImportMapping },
) =>
  unwrap(
    api.POST('/v1/data/imports/{name}/mappings', {
      params: { path: { name } },
      body,
    }),
  );

export const deleteMapping = (name: string, id: string) =>
  unwrap(
    api.DELETE('/v1/data/imports/{name}/mappings/{id}', {
      params: { path: { name, id } },
    }),
  );

// ------------------------------------------------------------------ lists

export type TransferKind = 'export' | 'import';
export type TransferState = Transfer['status'];
export type BulkRun = GetResponse<'/v1/bulk'>['items'][number];

const PAGE = 20;

/** The runs the worker still has. */
const activeJobs = (items: { id: string; status: string }[]) =>
  items.filter((item) => item.status === 'queued' || item.status === 'running');

/** A list's poll: ms for the runs still with the worker (never, with none). */
type ListPoll = (active: { id: string; status: string }[]) => number | false;
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
