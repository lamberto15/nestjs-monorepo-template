export type AnalyticsColumn = {
  name: string;
  type: string;
  nullCount: number;
  distinctCount: number;
  min: unknown;
  max: unknown;
};

export type AnalyticsDataset = {
  id: string;
  name: string;
  engineVersion: string;
  columns: AnalyticsColumn[];
  rowCount: number;
};

export type DatasetFilter = {
  column: string;
  operator:
    | 'eq'
    | 'neq'
    | 'contains'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'isNull'
    | 'isNotNull';
  value?: string | number | boolean | null;
};

export type DatasetQuery = {
  offset?: number;
  limit?: number;
  filters?: DatasetFilter[];
  sort?: { column: string; direction: 'asc' | 'desc' };
  groupBy?: string;
  aggregate?: { column?: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max' };
};

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
};

type WorkerReply = { id: number; result?: unknown; error?: string };
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

let worker: Worker | undefined;
let nextRequest = 0;
let lifecycle = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./duckdb.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error));
    else task.resolve(data.result);
  };
  worker.onerror = (event) => {
    const error = new Error(
      event.message || 'The local analytics worker stopped unexpectedly.',
    );
    for (const task of pending.values()) task.reject(error);
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

function request<T>(
  type: string,
  payload: Record<string, unknown> = {},
  transfer: Transferable[] = [],
): Promise<T> {
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    getWorker().postMessage({ id, type, ...payload }, transfer);
  });
}

/** Loads supported files entirely in a disposable browser worker. */
export async function loadLocalFile(file: File): Promise<AnalyticsDataset> {
  const currentLifecycle = lifecycle;
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (
    !extension ||
    !['csv', 'json', 'jsonl', 'ndjson', 'parquet'].includes(extension)
  ) {
    throw new Error('Choose a CSV, JSON, JSON Lines, or Parquet file.');
  }
  if (file.size === 0) throw new Error('The selected file is empty.');
  if (file.size > 1024 * 1024 * 1024)
    throw new Error('Files must be 1 GB or smaller.');
  const buffer = await file.arrayBuffer();
  if (currentLifecycle !== lifecycle)
    throw new Error('The local analytics session was closed.');
  return request<AnalyticsDataset>(
    'load',
    { name: file.name, extension, buffer },
    [buffer],
  );
}

export function queryDataset(
  dataset: AnalyticsDataset,
  query: DatasetQuery = {},
): Promise<QueryResult> {
  return request<QueryResult>('query', { datasetId: dataset.id, query });
}

export async function disposeDataset(dataset: AnalyticsDataset): Promise<void> {
  await request<void>('dispose', { datasetId: dataset.id });
}

/** Cancels in-flight local queries and releases DuckDB's worker and memory. */
export function terminateAnalyticsEngine(): void {
  lifecycle++;
  worker?.terminate();
  worker = undefined;
  const error = new Error('The local analytics session was closed.');
  for (const task of pending.values()) task.reject(error);
  pending.clear();
}
