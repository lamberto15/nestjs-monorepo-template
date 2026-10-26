import { PgDialect } from 'drizzle-orm/pg-core';
import {
  MetricSnapshot,
  OutboxMetricsReader,
} from './outbox-metrics.reader.js';

describe('MetricSnapshot', () => {
  it('shares an in-flight read and caches successful values for 30 seconds', async () => {
    let now = 10_000;
    let resolve!: (value: number) => void;
    const read = vi.fn(() => new Promise<number>((done) => (resolve = done)));
    const snapshot = new MetricSnapshot(read, () => now);

    const first = snapshot.get();
    const concurrent = snapshot.get();
    expect(read).toHaveBeenCalledTimes(1);
    resolve(7);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([7, 7]);
    await expect(snapshot.get()).resolves.toBe(7);
    expect(read).toHaveBeenCalledTimes(1);

    now += 30_001;
    const next = snapshot.get();
    resolve(8);
    await expect(next).resolves.toBe(8);
  });

  it('does not cache a failed read', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('database timeout'))
      .mockResolvedValue(4);
    const snapshot = new MetricSnapshot(read);
    await expect(snapshot.get()).rejects.toThrow('database timeout');
    await expect(snapshot.get()).resolves.toBe(4);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops the expired snapshot when refreshing fails', async () => {
    let now = 10_000;
    const read = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(new Error('database timeout'))
      .mockResolvedValueOnce(3);
    const snapshot = new MetricSnapshot(read, () => now);
    await expect(snapshot.get()).resolves.toBe(2);
    now += 30_001;
    await expect(snapshot.get()).rejects.toThrow('database timeout');
    await expect(snapshot.get()).resolves.toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('OutboxMetricsReader', () => {
  it('uses one read-only transaction with a 1500ms statement timeout', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ pending: '12', dead_letters: '2', oldest_due_at: '9000' }],
      });
    let options: unknown;
    const db = {
      transaction: async (
        work: (tx: { execute: typeof execute }) => unknown,
        given: unknown,
      ) => {
        options = given;
        return work({ execute });
      },
    };
    const reader = new OutboxMetricsReader(db as never);
    await expect(reader.read()).resolves.toEqual({
      pending: 12,
      deadLetters: 2,
      oldestDueAt: 9_000,
    });
    expect(options).toEqual({ accessMode: 'read only' });
    expect(execute).toHaveBeenCalledTimes(2);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(execute.mock.calls[0]![0]).sql).toContain(
      '1500ms',
    );
    expect(dialect.sqlToQuery(execute.mock.calls[1]![0]).sql).toContain(
      'nest_outbox.messages',
    );
  });
});
