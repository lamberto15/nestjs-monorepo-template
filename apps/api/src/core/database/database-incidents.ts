import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import type { PoolStats } from './database-health.js';

export type IncidentTrigger =
  'database_busy' | 'database_timeout' | 'slow_query' | 'pool_waiting';

export interface IncidentEvidence {
  trigger: IncidentTrigger;
  requestId?: string;
  traceId?: string;
  route?: string;
  fingerprint?: string;
  operation?: string;
  durationMs?: number;
  backendPid?: number;
  sqlstate?: string;
  reason?: string;
}

export interface DatabaseIncident extends IncidentEvidence {
  event: 'database_incident';
  incidentId: string;
  replica: string;
  pool: PoolStats;
  captureStatus:
    'pending' | 'unconfigured' | 'in_progress' | 'cooldown' | 'closed';
}

/** Log lines per fingerprint+trigger and window; metrics and listeners still see every incident. */
const LOG_LIMIT = 5;
const LOG_WINDOW_MS = 60_000;
const LOG_KEYS_MAX = 500;

interface LogWindow {
  trigger: IncidentTrigger;
  fingerprint?: string;
  start: number;
  logged: number;
  suppressed: number;
}

/** Statistics only: never select query text, parameters, users or application rows. */
const ACTIVITY = `select pid, state, query_id::text as "queryId",
  extract(epoch from (clock_timestamp() - query_start)) * 1000 as "queryAgeMs",
  extract(epoch from (clock_timestamp() - xact_start)) * 1000 as "transactionAgeMs",
  wait_event_type as "waitEventType", wait_event as "waitEvent",
  pg_blocking_pids(pid) as "blockingPids"
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
  and state is distinct from 'idle'
order by xact_start nulls last, pid
limit 20`;

/**
 * Custom capture: pg exposes activity statistics, but no incident collector.
 * A separate pg_monitor pool stays usable when the application's pool is full.
 */
export class DatabaseIncidents {
  private readonly logger = new Logger('DatabaseIncident');
  private readonly monitor?: pg.Pool;
  private inFlight = false;
  private nextCapture = 0;
  private closed = false;
  private readonly listeners = new Set<(incident: DatabaseIncident) => void>();
  // Custom: nothing in the repo or Nest samples logs. Insertion order is window-start order.
  private readonly logWindows = new Map<string, LogWindow>();

  constructor(
    private readonly stats: () => PoolStats,
    monitorUrl?: string,
    private readonly replica = `${hostname()}:${process.pid}`,
  ) {
    if (monitorUrl) {
      this.monitor = new pg.Pool({
        connectionString: monitorUrl,
        max: 1,
        connectionTimeoutMillis: 1000,
        statement_timeout: 1000,
        query_timeout: 1000,
        application_name: 'database-diagnostics',
        allowExitOnIdle: true,
      });
      // Driver errors may include connection strings: log only a fixed status.
      this.monitor.on('error', () => undefined);
    }
  }

  subscribe(listener: (incident: DatabaseIncident) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  record(evidence: IncidentEvidence): DatabaseIncident {
    const captureStatus = this.closed
      ? 'closed'
      : !this.monitor
        ? 'unconfigured'
        : this.inFlight
          ? 'in_progress'
          : Date.now() < this.nextCapture
            ? 'cooldown'
            : 'pending';
    const incident: DatabaseIncident = {
      ...evidence,
      event: 'database_incident',
      incidentId: randomUUID(),
      replica: this.replica,
      pool: this.stats(),
      captureStatus,
    };
    this.log(incident);
    for (const listener of this.listeners) {
      try {
        listener(incident);
      } catch {
        /* Diagnostics never affect requests. */
      }
    }
    if (captureStatus === 'pending') {
      this.inFlight = true;
      this.nextCapture = Date.now() + 30_000;
      void this.capture(incident);
    }
    return incident;
  }

  /** At most LOG_LIMIT lines per key and window; a closed window logs one summary. */
  private log(incident: DatabaseIncident) {
    const now = Date.now();
    const key = `${incident.trigger}:${incident.fingerprint ?? ''}`;
    let window = this.logWindows.get(key);
    if (window && now - window.start >= LOG_WINDOW_MS) {
      this.summarize(window);
      this.logWindows.delete(key);
      window = undefined;
    }
    if (!window) {
      if (this.logWindows.size >= LOG_KEYS_MAX) {
        const oldest = this.logWindows.keys().next().value as string;
        this.summarize(this.logWindows.get(oldest)!);
        this.logWindows.delete(oldest);
      }
      window = {
        trigger: incident.trigger,
        fingerprint: incident.fingerprint,
        start: now,
        logged: 0,
        suppressed: 0,
      };
      this.logWindows.set(key, window);
    }
    if (window.logged < LOG_LIMIT) {
      window.logged++;
      this.logger.warn('Database incident', incident);
    } else {
      window.suppressed++;
    }
  }

  private summarize(window: LogWindow) {
    if (window.suppressed === 0) return;
    this.logger.warn('Database incidents suppressed', {
      event: 'database_incident_summary',
      trigger: window.trigger,
      fingerprint: window.fingerprint,
      suppressed: window.suppressed,
      windowMs: LOG_WINDOW_MS,
      replica: this.replica,
    });
  }

  private async capture(incident: DatabaseIncident) {
    let client: pg.PoolClient | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = this.monitor!.connect().then(async (connection) => {
        if (expired) {
          connection.release(true);
          return [];
        }
        client = connection;
        try {
          // Fail closed if credentials name an application/owner role instead.
          const { rows } = await connection.query<{ allowed: boolean }>(
            `select pg_has_role(current_user, 'pg_monitor', 'member')
              and not rolsuper and not rolbypassrls and not rolcreaterole
              and not rolcreatedb and not rolreplication
              and not exists (select 1 from pg_auth_members where member = r.oid and roleid <> 'pg_monitor'::regrole)
              and not exists (select 1 from pg_database where datdba = r.oid)
              and not exists (select 1 from pg_namespace where nspowner = r.oid)
              and not exists (select 1 from pg_class where relowner = r.oid)
              as allowed from pg_roles r where rolname = current_user`,
          );
          if (!rows[0]?.allowed) throw new Error('monitor_role_required');
          return (await connection.query(ACTIVITY)).rows as unknown[];
        } finally {
          if (client === connection) {
            client = undefined;
            connection.release(expired);
          }
        }
      });
      const sessions = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('capture_timeout')), 1000);
          timer.unref();
        }),
      ]);
      this.logger.warn('Database activity snapshot', {
        event: 'database_snapshot',
        incidentId: incident.incidentId,
        requestId: incident.requestId,
        traceId: incident.traceId,
        route: incident.route,
        replica: this.replica,
        captureStatus: 'captured',
        sessions,
        observations: {
          blockedSessions: (sessions as { blockingPids: number[] }[]).filter(
            (s) => s.blockingPids.length > 0,
          ).length,
          // A sample is evidence of waits, not proof of the request's root cause.
          applicationPoolWaiting: incident.pool.waiting,
        },
      });
    } catch (error) {
      const known =
        error instanceof Error &&
        ['capture_timeout', 'monitor_role_required'].includes(error.message);
      this.logger.warn('Database activity snapshot unavailable', {
        event: 'database_snapshot',
        incidentId: incident.incidentId,
        requestId: incident.requestId,
        traceId: incident.traceId,
        route: incident.route,
        replica: this.replica,
        captureStatus: 'unavailable',
        reason: known ? (error as Error).message : 'monitor_unavailable',
      });
    } finally {
      expired = true;
      if (timer) clearTimeout(timer);
      // Destroy an in-progress diagnostic command at the overall deadline.
      const active = client;
      client = undefined;
      active?.release(true);
      this.inFlight = false;
    }
  }

  async close() {
    this.closed = true;
    for (const window of this.logWindows.values()) this.summarize(window);
    this.logWindows.clear();
    this.listeners.clear();
    await this.monitor?.end();
  }
}
