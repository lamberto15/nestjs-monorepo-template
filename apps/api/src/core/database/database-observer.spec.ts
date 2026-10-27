import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type pg from 'pg';
import { DatabasePoolMonitor } from './database-health.js';
import type { DatabaseHealth } from './database-health.js';
import {
  databaseFailure,
  databaseIncident,
  DatabaseObserver,
  inDatabaseContext,
} from './database-observer.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

describe('database observer', () => {
  const stats = () => ({ max: 10, inUse: 10, idle: 0, waiting: 2 });
  let observer: DatabaseObserver;
  let warnings: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnings = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    observer = new DatabaseObserver(stats);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await observer.incidents.close();
  });

  const clientOf = (query: (...args: unknown[]) => unknown) =>
    ({ query, processID: 123 }) as unknown as pg.PoolClient;

  it('separates pool acquisition from query duration and keeps bounded operation names', async () => {
    const samples = vi.fn();
    observer.subscribe(samples);
    const client = clientOf(async () => ({ rows: [] }));
    observer.instrument(client);
    expect(await observer.acquire(() => Promise.resolve(client), [])).toBe(
      client,
    );
    await client.query('select $1::text', ['private-note']);
    expect(
      samples.mock.calls.map(([s]) => [s.phase, s.operation, s.outcome]),
    ).toEqual([
      ['acquire', 'connect', 'success'],
      ['query', 'select', 'success'],
    ]);
    expect(JSON.stringify(samples.mock.calls)).not.toContain('private-note');
  });

  it('records acquisition failures once and preserves the error object', async () => {
    const error = new Error('timeout exceeded when trying to connect');
    const record = vi.spyOn(observer.incidents, 'record');
    await expect(
      observer.acquire(() => Promise.reject(error), []),
    ).rejects.toBe(error);
    const wrapped = new Error('Failed SQL: private-note', { cause: error });
    expect(databaseIncident(wrapped)?.trigger).toBe('database_busy');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('captures before a slow query finishes with request correlation but no text or values', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const client = clientOf(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    observer.instrument(client);
    const record = vi.spyOn(observer.incidents, 'record');
    const running = inDatabaseContext(
      { requestId: 'request-123', route: () => 'GET /v1/notes/{id}' },
      () => client.query('select $1::text', ['private-note']),
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'slow_query',
        requestId: 'request-123',
        route: 'GET /v1/notes/{id}',
        backendPid: 123,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-note');
    finish({ rows: [] });
    await running;
    await vi.advanceTimersByTimeAsync(2000);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('preserves safe cancellation reasons and never logs driver message/detail or parameters', async () => {
    const error = Object.assign(
      new Error('canceling statement due to statement timeout'),
      { code: '57014', detail: 'private-note' },
    );
    const client = clientOf(() => Promise.reject(error));
    observer.instrument(client);
    await expect(client.query('select $1', ['private-note'])).rejects.toBe(
      error,
    );
    expect(databaseIncident(error)).toMatchObject({
      sqlstate: '57014',
      reason: 'statement_timeout',
      captureStatus: 'unconfigured',
    });
    const logs = warnings.mock.calls;
    expect(JSON.stringify(logs)).not.toContain('private-note');
    expect(JSON.stringify(logs)).not.toContain('select $1');
    expect(
      databaseFailure({
        code: '57014',
        message: 'canceling statement due to user request',
      })?.reason,
    ).toBe('user_cancellation');
    expect(
      databaseFailure({ code: '57014', message: 'private-note' })?.reason,
    ).toBe('query_cancellation');
    expect(
      databaseFailure({ code: '23505', message: 'private-note' }),
    ).toBeUndefined();
  });

  it('records a slow completion even when the event loop delayed its watchdog', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1500);
    const client = clientOf(async () => ({ rows: [] }));
    observer.instrument(client);
    const record = vi.spyOn(observer.incidents, 'record');
    await client.query('select 1');
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ trigger: 'slow_query', durationMs: 1500 }),
    );
  });

  it('hashes each distinct query text once', async () => {
    const client = clientOf(async () => ({ rows: [] }));
    observer.instrument(client);
    const record = vi.spyOn(observer.incidents, 'record');
    vi.mocked(createHash).mockClear();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1500);
    await client.query('select cached_text_1');
    await client.query('select cached_text_1');
    expect(createHash).toHaveBeenCalledTimes(1);
    await client.query('select cached_text_2');
    expect(createHash).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it('ignores a slow duration explained by event-loop lag, but not the rest', async () => {
    let lag = 1400;
    const lagged = new DatabaseObserver(stats, undefined, () => lag);
    const record = vi.spyOn(lagged.incidents, 'record');
    const samples = vi.fn();
    lagged.subscribe(samples);
    const client = clientOf(async () => ({ rows: [] }));
    lagged.instrument(client);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValue(1500);
    await client.query('select 1');
    expect(record).not.toHaveBeenCalled();
    expect(samples).toHaveBeenCalledOnce();
    lag = 200;
    now.mockReset().mockReturnValueOnce(0).mockReturnValue(1500);
    await client.query('select 1');
    expect(record).toHaveBeenCalledOnce();
    await lagged.incidents.close();
  });

  it('re-checks a still-running query when lag explained its first second', async () => {
    vi.useFakeTimers();
    const lagged = new DatabaseObserver(stats, undefined, () => 300);
    const record = vi.spyOn(lagged.incidents, 'record');
    let finish!: (value: unknown) => void;
    const client = clientOf(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    lagged.instrument(client);
    const running = client.query('select pg_advisory_xact_lock(1)');
    await vi.advanceTimersByTimeAsync(1001);
    expect(record).not.toHaveBeenCalled();
    // Still blocked: recorded while running, once the lag is accounted for.
    await vi.advanceTimersByTimeAsync(300);
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ trigger: 'slow_query' }),
    );
    finish({ rows: [] });
    await running;
    await vi.advanceTimersByTimeAsync(2000);
    expect(record).toHaveBeenCalledOnce();
    await lagged.incidents.close();
  });

  it('preserves callback-style query and pool APIs, including release', async () => {
    const samples = vi.fn();
    observer.subscribe(samples);
    const client = clientOf((...args) => {
      (args.at(-1) as Function)(null, { rows: [1] });
    });
    observer.instrument(client);
    const release = vi.fn();
    const acquired = vi.fn();
    observer.acquire(
      (callback) => {
        (callback as Function)(null, client, release);
      },
      [acquired],
    );
    expect(acquired).toHaveBeenCalledWith(null, client, release);
    const callback = vi.fn();
    client.query('select 1', callback);
    expect(callback).toHaveBeenCalledWith(null, { rows: [1] });
    expect(samples).toHaveBeenCalledTimes(2);
  });

  it('observes synchronous query errors and event-based Query completion', () => {
    const samples = vi.fn();
    observer.subscribe(samples);
    const error = new Error('invalid query');
    const broken = clientOf(() => {
      throw error;
    });
    observer.instrument(broken);
    expect(() => broken.query('select 1')).toThrow(error);
    const events = new EventEmitter();
    const stream = clientOf(() => events);
    observer.instrument(stream);
    expect(stream.query('select 1')).toBe(events);
    events.emit('end');
    const failedEvents = new EventEmitter();
    const failedStream = clientOf(() => failedEvents);
    observer.instrument(failedStream);
    void failedStream.query('select 1');
    // Instrumentation must not turn an unhandled stream error into a silent failure.
    expect(() => failedEvents.emit('error', error)).toThrow(error);
    expect(samples.mock.calls.map(([s]) => s.outcome)).toEqual([
      'error',
      'success',
      'error',
    ]);
  });

  it('does not let a failing metrics subscriber alter queries', async () => {
    observer.subscribe(() => {
      throw new Error('metrics unavailable');
    });
    const client = clientOf(async () => 42);
    observer.instrument(client);
    await expect(client.query('select 42')).resolves.toBe(42);
  });

  it('captures pool waiting only after two consecutive checks and resets on recovery', () => {
    let waiting = 1;
    const health = {
      pool: () => ({ ...stats(), waiting }),
      observer: () => observer,
    } as unknown as DatabaseHealth;
    const monitor = new DatabasePoolMonitor(health);
    const record = vi.spyOn(observer.incidents, 'record');
    monitor.check();
    expect(record).not.toHaveBeenCalled();
    waiting = 0;
    monitor.check();
    waiting = 1;
    monitor.check();
    expect(record).not.toHaveBeenCalled();
    monitor.check();
    expect(record).toHaveBeenCalledWith({
      trigger: 'pool_waiting',
      reason: 'sustained_connection_wait',
    });
  });
});
