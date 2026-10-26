import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { refusals } from './database-errors.js';
import type { TenantPool } from '../tenancy/tenant-pool.js';
import type { Database } from './drizzle.js';

export type PoolStats = {
  max: number;
  inUse: number;
  idle: number;
  waiting: number;
};

/**
 * The database's health: a probe for the readiness check, and the pool's use.
 * Terminus has no Drizzle indicator, so the health controller asks this.
 */
@Injectable()
export class DatabaseHealth {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async ping() {
    await this.db.execute(sql`select 1`);
  }

  observer() {
    return (this.db as unknown as { $client: TenantPool }).$client.observer;
  }

  /** The pool's use now. */
  pool(): PoolStats {
    // Drizzle's driver client, a node-postgres Pool (Database is the
    // driver-neutral type, without $client).
    const pool = (this.db as unknown as { $client: Pool }).$client;
    return {
      max: pool.options.max ?? 10,
      inUse: pool.totalCount - pool.idleCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }
}

/** How often the pool is looked at. */
const EVERY_MS = 5000;

/**
 * Warns when the pool runs short: queries waiting for a connection now, or
 * requests refused with 503 database_busy since the last look (a burst between
 * two looks is counted, not missed). Once per interval while it lasts, once
 * when it ends.
 */
@Injectable()
export class DatabasePoolMonitor
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('DatabasePool');
  private timer?: NodeJS.Timeout;
  private saturated = false;
  private waitingChecks = 0;

  constructor(private readonly health: DatabaseHealth) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.check(), EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  check() {
    const pool = this.health.pool();
    this.waitingChecks = pool.waiting > 0 ? this.waitingChecks + 1 : 0;
    if (this.waitingChecks >= 2) {
      this.health.observer()?.incidents.record({
        trigger: 'pool_waiting',
        reason: 'sustained_connection_wait',
      });
      this.waitingChecks = 0;
    }
    const refused = refusals.busy;
    refusals.busy = 0;
    if (pool.waiting > 0 || refused > 0) {
      this.saturated = true;
      this.logger.warn(
        `Pool short: ${pool.waiting} queries waiting, ${refused} requests refused (database_busy) in ${EVERY_MS / 1000} s; ${pool.inUse}/${pool.max} in use. Inspect database_incident and database_snapshot evidence in the Database Incidents dashboard.`,
      );
    } else if (this.saturated) {
      this.saturated = false;
      this.logger.log(
        `Pool recovered: nothing waiting or refused (${pool.inUse}/${pool.max} in use).`,
      );
    }
  }
}
