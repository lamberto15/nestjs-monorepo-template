import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { setTimeout } from 'node:timers/promises';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { REDIS } from '../../core/redis/redis.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { apiClients } from '../../iam/iam.tables.js';
import {
  addDays,
  daysBetween,
  LIVE_TTL_SECONDS,
  TOTAL_FIELD,
  usageKey,
  utcDay,
} from './usage-keys.js';
import { apiUsage } from './usage.tables.js';

/** The longest range one usage report covers. */
export const MAX_REPORT_DAYS = 400;
/** How long a request waits for Redis before going on without its counters. */
const REDIS_READ_TIMEOUT_MS = 500;
/** The range when none is asked for: the last 30 days, today included. */
const DEFAULT_REPORT_DAYS = 30;

/** One day of a client's usage. */
export interface UsageDay {
  day: string;
  total: number;
  routes: Record<string, number>;
}

/** A client's usage over a range of UTC days, both ends included. */
export interface UsageReport {
  from: string;
  to: string;
  days: UsageDay[];
  total: number;
}

/**
 * API clients' requests, counted per UTC day and route. The live counters
 * are Redis hashes (`tenant:<id>:usage:<clientId>:<day>`, one field per route and
 * `_total`), incremented after each response (UsageInterceptor) and copied
 * every night into `api_usage` (UsageRollupJob). Reports merge both, so
 * today is always included.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger('Usage');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  /**
   * Counts one request: route and total in one round trip; the TTL is set by
   * the day's first increment. Never fails or delays the request: an error
   * is logged and the request goes uncounted.
   */
  count(
    client: { id: string; tenantId: string },
    route: string,
    at = new Date(),
    /** false: the total was taken on entry (`take`); only the route counts now. */
    total = true,
  ) {
    if (this.redis.status !== 'ready') {
      // Not queued for a reconnect that may never come: the request goes uncounted.
      this.logger.warn(`Usage not counted: Redis is ${this.redis.status}`);
      return;
    }
    const key = usageKey(client.tenantId, client.id, utcDay(at));
    const pipeline = this.redis.pipeline().hincrby(key, route, 1);
    if (total) {
      pipeline.hincrby(key, TOTAL_FIELD, 1);
    }
    pipeline
      .expire(key, LIVE_TTL_SECONDS, 'NX')
      .exec()
      .then((results) => {
        const failed = results?.find(([error]) => error)?.[0];
        if (failed) {
          throw failed;
        }
      })
      .catch((error: Error) =>
        this.logger.warn(`Usage not counted: ${error.message}`),
      );
  }

  /**
   * Takes one request of today's quota, atomically: the total goes up first,
   * and past the quota comes back down (so a refused request isn't counted),
   * so a burst of parallel requests gets exactly `quota` through. Redis
   * unreachable (or slow): allowed, with no count (an outage lets requests
   * through rather than refusing them all; logged).
   */
  async take(
    client: { id: string; tenantId: string },
    quota: number,
    at = new Date(),
  ): Promise<{ allowed: boolean; used: number | null }> {
    const key = usageKey(client.tenantId, client.id, utcDay(at));
    const total = await this.fromRedis(
      'Quota not checked',
      async () => {
        const results = await this.redis
          .pipeline()
          .hincrby(key, TOTAL_FIELD, 1)
          .expire(key, LIVE_TTL_SECONDS, 'NX')
          .exec();
        const [error, value] = results![0]!;
        if (error) {
          throw error;
        }
        return Number(value);
      },
      null,
    );
    if (total === null) {
      return { allowed: true, used: null };
    }
    if (total > quota) {
      // Not this one: the request is refused, so it doesn't count.
      this.redis
        .hincrby(key, TOTAL_FIELD, -1)
        .catch((error: Error) =>
          this.logger.warn(`Quota count not given back: ${error.message}`),
        );
      return { allowed: false, used: quota };
    }
    return { allowed: true, used: total };
  }

  /**
   * The client's requests so far today (UTC). Redis unreachable: 0, logged,
   * so an outage lets requests through rather than refusing them all.
   */
  async today(client: { id: string; tenantId: string }, at = new Date()) {
    const total = await this.fromRedis(
      'Quota not checked',
      () =>
        this.redis.hget(
          usageKey(client.tenantId, client.id, utcDay(at)),
          TOTAL_FIELD,
        ),
      null,
    );
    return Number(total ?? 0);
  }

  /**
   * A read that never holds a request up: the shared client queues commands
   * until Redis is back (maxRetriesPerRequest: null), so a disconnected
   * client answers `fallback` at once, and a slow one after
   * REDIS_READ_TIMEOUT_MS; both logged.
   */
  private async fromRedis<T>(
    what: string,
    read: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    if (this.redis.status !== 'ready') {
      this.logger.warn(`${what}: Redis is ${this.redis.status}`);
      return fallback;
    }
    const gaveUp = Symbol('timeout');
    try {
      const result = await Promise.race([
        read(),
        // ref: false, so a pending timer never keeps the process alive.
        setTimeout(REDIS_READ_TIMEOUT_MS, gaveUp, { ref: false }),
      ]);
      if (result === gaveUp) {
        this.logger.warn(
          `${what}: Redis took over ${REDIS_READ_TIMEOUT_MS} ms`,
        );
        return fallback;
      }
      return result as T;
    } catch (error) {
      this.logger.warn(`${what}: ${(error as Error).message}`);
      return fallback;
    }
  }

  /** An API client's usage, for the access API: a 404 for an unknown client. */
  async forClient(clientId: string, range: { from?: string; to?: string }) {
    const [client] = await this.db
      .select({ id: apiClients.id })
      .from(apiClients)
      .where(eq(apiClients.id, clientId));
    if (!client) {
      throw new NotFoundException(`API client ${clientId} not found.`);
    }
    return this.report(clientId, range);
  }

  /**
   * Usage per day from `from` to `to` (UTC days, both included; default the
   * last 30 days). Rolled-up rows, merged with the live counters of the days
   * still in Redis (today, and days not rolled up yet): per route, the larger
   * count wins, since a row is a copy of its day's counter.
   */
  async report(
    clientId: string,
    range: { from?: string; to?: string },
    now = new Date(),
  ): Promise<UsageReport> {
    // The client's tenant is the request's: a client of another is no row
    // (row-level security) and no counter (its keys are under its tenant).
    const tenantId = requireTenantId('A usage report');
    const today = utcDay(now);
    const to = range.to ?? today;
    const from = range.from ?? addDays(to, -(DEFAULT_REPORT_DAYS - 1));
    if (from > to) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'from must not be after to.',
        errors: [{ path: 'from', message: 'from must not be after to.' }],
      });
    }
    // The span first, arithmetically: a list of every day since year 1 is not built to be refused.
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (span > MAX_REPORT_DAYS) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `A report covers at most ${MAX_REPORT_DAYS} days.`,
        errors: [
          {
            path: 'from',
            message: `A report covers at most ${MAX_REPORT_DAYS} days.`,
          },
        ],
      });
    }
    const days = daysBetween(from, to);
    const counts = new Map<string, Map<string, number>>(
      days.map((day) => [day, new Map()]),
    );
    const add = (day: string, route: string, count: number) => {
      const routes = counts.get(day);
      if (routes && route !== TOTAL_FIELD) {
        routes.set(route, Math.max(routes.get(route) ?? 0, count));
      }
    };

    const rows = await this.db
      .select({
        day: apiUsage.day,
        route: apiUsage.route,
        count: apiUsage.count,
      })
      .from(apiUsage)
      .where(
        and(
          eq(apiUsage.clientId, clientId),
          gte(apiUsage.day, from),
          lte(apiUsage.day, to),
        ),
      );
    for (const row of rows) {
      add(row.day, row.route, row.count);
    }

    // Only the days whose counters can still be in Redis (their TTL).
    const live = days.filter(
      (day) => day <= today && day >= addDays(today, -3),
    );
    if (live.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const day of live) {
        pipeline.hgetall(usageKey(tenantId, clientId, day));
      }
      // Redis unreachable: the rolled-up rows alone, logged.
      const results = await this.fromRedis(
        'Live usage not read',
        async () => {
          const replies = (await pipeline.exec()) ?? [];
          const failed = replies.find(([error]) => error)?.[0];
          if (failed) {
            throw failed;
          }
          return replies;
        },
        [],
      );
      results.forEach(([, hash], index) => {
        for (const [route, count] of Object.entries(
          hash as Record<string, string>,
        )) {
          add(live[index], route, Number(count));
        }
      });
    }

    const report = days.map((day) => {
      const routes = Object.fromEntries(
        [...counts.get(day)!].sort(([a], [b]) => a.localeCompare(b)),
      );
      const total = Object.values(routes).reduce((sum, n) => sum + n, 0);
      return { day, total, routes };
    });
    return {
      from,
      to,
      days: report,
      total: report.reduce((sum, day) => sum + day.total, 0),
    };
  }
}
