import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { errorMonitor } from 'node:events';
import { trace } from '@opentelemetry/api';
import type pg from 'pg';
import {
  DatabaseIncidents,
  type DatabaseIncident,
  type IncidentEvidence,
} from './database-incidents.js';
import type { PoolStats } from './database-health.js';

interface DatabaseContext {
  requestId?: string;
  route: () => string | undefined;
  observer?: DatabaseObserver;
}
const context = new AsyncLocalStorage<DatabaseContext>();
export const inDatabaseContext = <T>(value: DatabaseContext, work: () => T) =>
  context.run(value, work);

const incidents = new WeakMap<object, DatabaseIncident>();

/** Only fixed reasons escape the driver; its message/detail can contain SQL data. */
export function databaseFailure(error: unknown):
  | {
      code: 'database_busy' | 'database_timeout';
      sqlstate?: string;
      reason: string;
    }
  | undefined {
  for (
    let e = error, depth = 0;
    e && typeof e === 'object' && depth < 5;
    depth++
  ) {
    const driver = e as { code?: string; message?: string; cause?: unknown };
    if (
      typeof driver.message === 'string' &&
      driver.message.includes('timeout exceeded when trying to connect')
    ) {
      return {
        code: 'database_busy',
        reason: 'connection_acquisition_timeout',
      };
    }
    if (driver.code === '57014') {
      return {
        code: 'database_timeout',
        sqlstate: '57014',
        reason:
          driver.message === 'canceling statement due to statement timeout'
            ? 'statement_timeout'
            : driver.message === 'canceling statement due to user request'
              ? 'user_cancellation'
              : 'query_cancellation',
      };
    }
    e = driver.cause;
  }
  return undefined;
}

/** Reuse the driver's incident when the HTTP filter later unwraps the error. */
export function databaseIncident(error: unknown): DatabaseIncident | undefined {
  for (
    let e = error, depth = 0;
    e && typeof e === 'object' && depth < 5;
    depth++
  ) {
    const found = incidents.get(e);
    if (found) return found;
    e = (e as { cause?: unknown }).cause;
  }
  const failure = databaseFailure(error);
  return failure
    ? context.getStore()?.observer?.failure(error, {}, failure)
    : undefined;
}

export interface DatabaseMeasurement {
  phase: 'acquire' | 'query';
  operation: string;
  outcome: 'success' | 'error';
  durationMs: number;
}

const operationOf = (sql: string) => {
  const first =
    /^\s*(select|insert|update|delete|begin|start|commit|rollback|set|show|with)\b/i
      .exec(sql)?.[1]
      ?.toLowerCase();
  return first ?? 'other';
};
const textOf = (query: unknown) =>
  typeof query === 'string'
    ? query
    : typeof (query as { text?: unknown } | null)?.text === 'string'
      ? (query as { text: string }).text
      : '';

/**
 * Uses pg's documented promise/callback APIs. OpenTelemetry is optional and
 * samples traces; local incident capture must also work without a collector.
 */
export class DatabaseObserver {
  readonly incidents: DatabaseIncidents;
  private readonly listeners = new Set<(sample: DatabaseMeasurement) => void>();

  constructor(stats: () => PoolStats, monitorUrl?: string) {
    this.incidents = new DatabaseIncidents(stats, monitorUrl);
  }

  subscribe(listener: (sample: DatabaseMeasurement) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private measure(sample: DatabaseMeasurement) {
    for (const listener of this.listeners) {
      try {
        listener(sample);
      } catch {
        /* Observability must never fail a query. */
      }
    }
  }

  failure(
    error: unknown,
    evidence: Omit<IncidentEvidence, 'trigger'>,
    failure = databaseFailure(error),
  ) {
    if (!failure) return undefined;
    if (error && typeof error === 'object') {
      const existing = incidents.get(error);
      if (existing) return existing;
    }
    const incident = this.incidents.record({
      ...this.evidence(),
      ...evidence,
      trigger: failure.code,
      sqlstate: failure.sqlstate,
      reason: failure.reason,
    });
    if (error && typeof error === 'object') incidents.set(error, incident);
    return incident;
  }

  private evidence(): Omit<IncidentEvidence, 'trigger'> {
    const current = context.getStore();
    if (current) current.observer = this;
    const span = trace.getActiveSpan()?.spanContext();
    return {
      requestId: current?.requestId,
      route: current?.route() ?? 'background',
      traceId: span?.traceId,
    };
  }

  /** Wrap the callback, without changing pg's release callback or return type. */
  acquire(invoke: (...args: unknown[]) => unknown, args: unknown[]): unknown {
    const started = performance.now();
    const evidence = this.evidence();
    const done = (error?: unknown) => {
      const durationMs = performance.now() - started;
      this.measure({
        phase: 'acquire',
        operation: 'connect',
        outcome: error ? 'error' : 'success',
        durationMs,
      });
      if (error)
        this.failure(error, { ...evidence, operation: 'connect', durationMs });
    };
    const callback = args[0];
    if (typeof callback === 'function') {
      return invoke((error: unknown, ...rest: unknown[]) => {
        done(error);
        callback(error, ...rest);
      });
    }
    try {
      return (invoke(...args) as Promise<unknown>).then(
        (client) => {
          done();
          return client;
        },
        (error: unknown) => {
          done(error);
          throw error;
        },
      );
    } catch (error) {
      done(error);
      throw error;
    }
  }

  instrument(client: pg.PoolClient) {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    client.query = ((...args: unknown[]) => {
      const sql = textOf(args[0]);
      const operation = operationOf(sql);
      const evidence = {
        ...this.evidence(),
        operation,
        fingerprint: createHash('sha256').update(sql).digest('hex'),
        backendPid: (client as unknown as { processID: number }).processID,
      };
      const started = performance.now();
      let finished = false;
      let slowRecorded = false;
      // Capture while the query is still running so blockers have not disappeared.
      const slow = () => {
        if (slowRecorded) return;
        slowRecorded = true;
        this.incidents.record({
          ...evidence,
          trigger: 'slow_query',
          durationMs: performance.now() - started,
        });
      };
      const timer = setTimeout(slow, 1000);
      timer.unref();
      const done = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const durationMs = performance.now() - started;
        // I/O completion can beat a delayed watchdog when the event loop is busy.
        if (durationMs >= 1000) slow();
        this.measure({
          phase: 'query',
          operation,
          outcome: error ? 'error' : 'success',
          durationMs,
        });
        if (error) this.failure(error, { ...evidence, durationMs });
      };
      // pg also accepts a callback inside QueryConfig, and streaming Query objects.
      const config = args[0] as {
        callback?: (...values: unknown[]) => void;
      } | null;
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = (error: unknown, ...rest: unknown[]) => {
          done(error);
          last(error, ...rest);
        };
      } else if (
        config &&
        typeof config === 'object' &&
        typeof config.callback === 'function'
      ) {
        const callback = config.callback;
        // Do not clone Query instances: pg relies on their prototype and identity.
        config.callback = (error: unknown, ...rest: unknown[]) => {
          done(error);
          callback(error, ...rest);
        };
      }
      try {
        const result = original(...args);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).then(
            (value) => {
              done();
              return value;
            },
            (error: unknown) => {
              done(error);
              throw error;
            },
          );
        }
        // Streaming Query instances emit end/error rather than returning a promise.
        if (
          result &&
          typeof (result as { once?: unknown }).once === 'function'
        ) {
          const query = result as {
            once(
              event: string | symbol,
              listener: (...args: unknown[]) => void,
            ): unknown;
          };
          query.once('end', () => done());
          // errorMonitor observes without consuming an otherwise unhandled error.
          query.once(errorMonitor, (error) => done(error));
        }
        return result;
      } catch (error) {
        done(error);
        throw error;
      }
    }) as pg.PoolClient['query'];
  }
}
