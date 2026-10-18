import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
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

/**
 * `GET /v1/data`: what the caller may export and import. The OpenAPI
 * document does not describe its answer (docs/data-transfer.md does), so the
 * type is written here until it does (#136).
 */
export interface DataCatalog {
  exports: { name: string; columns: string[]; formats: TransferFormat[] }[];
  imports: {
    name: string;
    formats: TransferFormat[];
    columns: {
      name: string;
      type: string;
      required: boolean;
      min?: number;
      max?: number;
      example?: unknown;
    }[];
    template: string;
  }[];
}

export const catalogQuery = queryOptions({
  queryKey: ['data', 'catalog'],
  queryFn: async () =>
    (await unwrap(api.GET('/v1/data'))) as unknown as DataCatalog,
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

// ---------------------------------------------------------------- history

export interface Started {
  id: string;
  kind: 'export' | 'import';
  name: string;
  at: string;
}

const HISTORY_KEY = 'transfers';
const HISTORY_MAX = 30;

/**
 * The API has no list of a user's transfers (only `GET /v1/data/transfers/{id}`;
 * #136), so the ids this browser started are remembered here, per user.
 */
export function readHistory(userId: string): Started[] {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}') as Record<
      string,
      Started[]
    >;
    return Array.isArray(all[userId]) ? all[userId] : [];
  } catch {
    return [];
  }
}

function writeHistory(userId: string, items: Started[]) {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}') as Record<
      string,
      Started[]
    >;
    all[userId] = items.slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {
    // storage blocked: the page lists nothing, the jobs still run
  }
}

export function remember(userId: string, started: Started) {
  writeHistory(userId, [
    started,
    ...readHistory(userId).filter((item) => item.id !== started.id),
  ]);
}

export function forget(userId: string, id: string) {
  writeHistory(
    userId,
    readHistory(userId).filter((item) => item.id !== id),
  );
}
