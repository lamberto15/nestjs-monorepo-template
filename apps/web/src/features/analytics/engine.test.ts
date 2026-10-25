import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeDataset,
  loadLocalFile,
  queryDataset,
  terminateAnalyticsEngine,
  type AnalyticsDataset,
  type DatasetQuery,
  type QueryResult,
} from './engine';

type WorkerRequest = {
  id: number;
  type: string;
  datasetId?: string;
  query?: DatasetQuery;
  name?: string;
  extension?: string;
  buffer?: ArrayBuffer;
};

const workers: TestWorker[] = [];

// The browser owns DuckDB execution; this fake exercises the public worker
// message boundary while letting replies arrive in any order.
class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage =
    vi.fn<(request: WorkerRequest, transfer: Transferable[]) => void>();
  terminate = vi.fn();

  constructor() {
    workers.push(this);
  }

  reply(id: number, result: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: { id, result } }));
  }

  reject(id: number, error: string) {
    this.onmessage?.(new MessageEvent('message', { data: { id, error } }));
  }

  fail(message: string) {
    this.onerror?.(new ErrorEvent('error', { message }));
  }

  request(index = 0): WorkerRequest {
    return this.postMessage.mock.calls[index]![0];
  }
}

const dataset: AnalyticsDataset = {
  id: 'local-sales',
  name: 'sales.csv',
  engineVersion: 'test',
  columns: [],
  rowCount: 2,
};

const result: QueryResult = {
  columns: ['amount'],
  rows: [{ amount: 12 }, { amount: 24 }],
  totalRows: 2,
};

function localFile(name: string, size = 4) {
  const file = new File(['data'], name);
  const buffer = new ArrayBuffer(4);
  const read = vi.fn(() => Promise.resolve(buffer));
  // jsdom's File lacks Blob.arrayBuffer; retain real File metadata and supply
  // only this browser API so validation and async reading stay independent.
  Object.defineProperties(file, {
    size: { value: size },
    arrayBuffer: { value: read },
  });
  return { file, buffer, read };
}

beforeEach(() => {
  workers.length = 0;
  vi.stubGlobal('Worker', TestWorker);
});

afterEach(() => {
  terminateAnalyticsEngine();
  vi.unstubAllGlobals();
});

describe('local analytics engine', () => {
  it.each(['csv', 'json', 'jsonl', 'ndjson', 'parquet', 'CSV'])(
    'loads a .%s file and transfers its bytes to the worker',
    async (extension) => {
      const { file, buffer, read } = localFile(`sales.${extension}`);
      const loading = loadLocalFile(file);
      await Promise.resolve();

      expect(read).toHaveBeenCalledOnce();
      const worker = workers[0]!;
      expect(worker.postMessage).toHaveBeenCalledWith(
        {
          id: expect.any(Number),
          type: 'load',
          name: file.name,
          extension: extension.toLowerCase(),
          buffer,
        },
        [buffer],
      );
      worker.reply(worker.request().id, dataset);
      await expect(loading).resolves.toEqual(dataset);
    },
  );

  it.each([
    ['sales.xlsx', 4, 'Choose a CSV, JSON, JSON Lines, or Parquet file.'],
    ['', 4, 'Choose a CSV, JSON, JSON Lines, or Parquet file.'],
    ['sales.csv', 0, 'The selected file is empty.'],
    ['sales.parquet', 1024 ** 3 + 1, 'Files must be 1 GB or smaller.'],
  ])(
    'rejects invalid file %j (%s bytes) before reading it',
    async (name, size, message) => {
      const { file, read } = localFile(name, size);

      await expect(loadLocalFile(file)).rejects.toThrow(message);
      expect(read).not.toHaveBeenCalled();
      expect(workers).toHaveLength(0);
    },
  );

  it('accepts a file at the size limit', async () => {
    const { file } = localFile('sales.parquet', 1024 ** 3);
    const loading = loadLocalFile(file);
    await Promise.resolve();

    workers[0]!.reply(workers[0]!.request().id, dataset);
    await expect(loading).resolves.toEqual(dataset);
  });

  it('keeps concurrent query results associated with their requests', async () => {
    const query: DatasetQuery = {
      offset: 10,
      limit: 5,
      filters: [{ column: 'amount', operator: 'gt', value: 10 }],
      sort: { column: 'amount', direction: 'desc' },
    };
    const first = queryDataset(dataset);
    const second = queryDataset({ ...dataset, id: 'other-sales' }, query);
    const worker = workers[0]!;
    expect(workers).toHaveLength(1);
    expect(worker.request()).toEqual({
      id: expect.any(Number),
      type: 'query',
      datasetId: dataset.id,
      query: {},
    });
    expect(worker.request(1)).toEqual({
      id: expect.any(Number),
      type: 'query',
      datasetId: 'other-sales',
      query,
    });

    const otherResult: QueryResult = { columns: [], rows: [], totalRows: 0 };
    worker.reply(worker.request(1).id, otherResult);
    worker.reply(worker.request().id, result);
    await expect(first).resolves.toEqual(result);
    await expect(second).resolves.toEqual(otherResult);
  });

  it('rejects a failed request while another request can still succeed', async () => {
    const failed = queryDataset(dataset);
    const succeeded = queryDataset(dataset, { limit: 1 });
    const rejection = expect(failed).rejects.toThrow('Unknown column: missing');
    const worker = workers[0]!;

    worker.reject(worker.request().id, 'Unknown column: missing');
    worker.reply(worker.request(1).id, result);
    await rejection;
    await expect(succeeded).resolves.toEqual(result);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('ignores duplicate replies and replies with an unknown request ID', async () => {
    const first = queryDataset(dataset);
    const second = queryDataset(dataset);
    const settled = vi.fn();
    void second.then(settled);
    const worker = workers[0]!;

    worker.reply(worker.request().id, result);
    await expect(first).resolves.toEqual(result);
    worker.reply(worker.request().id, { rows: ['duplicate'] });
    worker.reply(-1, { rows: ['unknown'] });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    worker.reply(worker.request(1).id, result);
    await expect(second).resolves.toEqual(result);
  });

  it.each([
    ['Worker ran out of memory', 'Worker ran out of memory'],
    ['', 'The local analytics worker stopped unexpectedly.'],
  ])(
    'rejects all pending requests after a worker error (%j) and recovers',
    async (message, expected) => {
      const first = queryDataset(dataset);
      const second = queryDataset(dataset);
      const rejections = Promise.all([
        expect(first).rejects.toThrow(expected),
        expect(second).rejects.toThrow(expected),
      ]);
      const failedWorker = workers[0]!;

      failedWorker.fail(message);
      await rejections;
      expect(failedWorker.terminate).toHaveBeenCalledOnce();

      const recovered = queryDataset(dataset);
      expect(workers).toHaveLength(2);
      const replacement = workers[1]!;
      replacement.reply(replacement.request().id, result);
      await expect(recovered).resolves.toEqual(result);
    },
  );

  it('cancels pending queries and ignores stale replies after starting a new session', async () => {
    const first = queryDataset(dataset);
    const second = queryDataset(dataset);
    const rejections = Promise.all([
      expect(first).rejects.toThrow('The local analytics session was closed.'),
      expect(second).rejects.toThrow('The local analytics session was closed.'),
    ]);
    const previous = workers[0]!;

    terminateAnalyticsEngine();
    await rejections;
    expect(previous.terminate).toHaveBeenCalledOnce();

    const next = queryDataset(dataset);
    const settled = vi.fn();
    void next.then(settled);
    expect(workers).toHaveLength(2);
    previous.reply(previous.request().id, { rows: ['stale'] });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    const replacement = workers[1]!;
    replacement.reply(replacement.request().id, result);
    await expect(next).resolves.toEqual(result);
  });

  it('does not restart a closed session when a pending file read finishes', async () => {
    const { file, buffer, read } = localFile('sales.csv');
    let finishRead!: (buffer: ArrayBuffer) => void;
    read.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const loading = loadLocalFile(file);
    const rejection = expect(loading).rejects.toThrow(
      'The local analytics session was closed.',
    );

    terminateAnalyticsEngine();
    finishRead(buffer);
    await rejection;
    expect(workers).toHaveLength(0);
  });

  it('reports a file read error without starting a worker', async () => {
    const { file, read } = localFile('sales.csv');
    read.mockRejectedValue(new Error('File is no longer readable'));

    await expect(loadLocalFile(file)).rejects.toThrow(
      'File is no longer readable',
    );
    expect(workers).toHaveLength(0);
  });

  it('waits for disposal acknowledgement and keeps other datasets usable', async () => {
    const disposing = disposeDataset(dataset);
    const disposed = vi.fn();
    void disposing.then(disposed);
    const worker = workers[0]!;
    expect(worker.request()).toEqual({
      id: expect.any(Number),
      type: 'dispose',
      datasetId: dataset.id,
    });
    await Promise.resolve();
    expect(disposed).not.toHaveBeenCalled();

    worker.reply(worker.request().id, undefined);
    await expect(disposing).resolves.toBeUndefined();
    expect(worker.terminate).not.toHaveBeenCalled();

    const querying = queryDataset({ ...dataset, id: 'other-sales' });
    expect(workers).toHaveLength(1);
    worker.reply(worker.request(1).id, result);
    await expect(querying).resolves.toEqual(result);
  });
});
