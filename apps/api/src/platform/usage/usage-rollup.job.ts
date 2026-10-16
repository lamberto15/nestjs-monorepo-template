import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { inArray, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { REDIS } from '../../core/redis/redis.js';
import { apiClients } from '../../iam/iam.tables.js';
import type { PlatformEnv } from '../platform.env.js';
import {
  addDays,
  parseUsageKey,
  TOTAL_FIELD,
  usagePattern,
  utcDay,
} from './usage-keys.js';
import { apiUsage } from './usage.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { USAGE_ROLLUP_JOB } from '../platform.jobs.js';

/** A live counter: its key (without REDIS_PREFIX), tenant, client and day. */
type UsageKey = {
  key: string;
  tenantId: string;
  clientId: string;
  day: string;
};

/**
 * Copies API clients' daily counters from Redis into `api_usage`, every
 * night at 00:20 UTC on one instance, then deletes the copied counters and
 * the rows older than USAGE_RETENTION_DAYS. Copying sets each row to its
 * counter's value, so a run interrupted before the delete can run again,
 * and a day rolled up early (today) is overwritten by the next run.
 *
 * Each counter's key names its tenant (`tenant:<id>:usage:…`): its rows are
 * written in that tenant's scope (docs/tenancy.md), one tenant at a time,
 * logged; the retention delete sweeps the whole table by age under the
 * worker's row-level security bypass.
 */
@Injectable()
export class UsageRollupJob {
  private readonly logger = new Logger('Usage');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  /**
   * Rolls up `day` (a UTC `yyyy-mm-dd`), or, without one, every day before
   * today still in Redis (yesterday, and a night that was missed). Returns
   * the rows written.
   */
  @Cron('20 0 * * *', { name: 'usage-rollup', timeZone: 'UTC' })
  @OnOneInstance({ key: 'usage:rollup' })
  @WithoutOverlapping()
  run(day?: string, now = new Date()) {
    return this.system.run(
      USAGE_ROLLUP_JOB,
      async () => {
        const today = utcDay(now);
        const keys = await this.liveKeys(usagePattern(day));
        const days = day
          ? [day]
          : [...new Set(keys.map((key) => key.day))].filter((d) => d < today);
        let written = 0;
        for (const each of days) {
          written += await this.rollUp(
            each,
            keys.filter((key) => key.day === each),
            now,
          );
        }
        const retentionDays = this.config.get('USAGE_RETENTION_DAYS', {
          infer: true,
        });
        const deleted = await this.tenancy.bypass(USAGE_ROLLUP_JOB.key, () =>
          this.db
            .delete(apiUsage)
            .where(lt(apiUsage.day, addDays(today, -retentionDays)))
            .returning({ id: apiUsage.id }),
        );
        this.logger.log('Usage rolled up', {
          days,
          written,
          deleted: deleted.length,
          retentionDays,
        });
        return written;
      },
      { transaction: false },
    );
  }

  /**
   * Copies one day's counters into the table, then deletes them (not
   * today's, which keep counting), tenant by tenant. Returns the rows written.
   */
  async rollUp(day: string, keys?: UsageKey[], now = new Date()) {
    const found = (keys ?? (await this.liveKeys(usagePattern(day)))).filter(
      (key) => key.day === day,
    );
    let written = 0;
    for (const tenantId of new Set(found.map((key) => key.tenantId))) {
      const ofTenant = found.filter((key) => key.tenantId === tenantId);
      written += await this.tenancy.run(tenantId, () =>
        this.rollUpTenant(day, ofTenant, now),
      );
      this.logger.debug('Usage rolled up for a tenant', {
        tenant: tenantId,
        day,
        clients: ofTenant.length,
      });
    }
    return written;
  }

  /** One tenant's counters of a day, in its scope: its clients only. */
  private async rollUpTenant(day: string, found: UsageKey[], now: Date) {
    if (found.length === 0) {
      return 0;
    }
    // Counters of clients that no longer exist are dropped with the rest.
    const existing = new Set(
      (
        await this.db
          .select({ id: apiClients.id })
          .from(apiClients)
          .where(
            inArray(
              apiClients.id,
              found.map((key) => key.clientId),
            ),
          )
      ).map((client) => client.id),
    );
    const pipeline = this.redis.pipeline();
    for (const { key } of found) {
      pipeline.hgetall(key);
    }
    const hashes = (await pipeline.exec()) ?? [];
    const rows = found.flatMap(({ clientId }, index) => {
      const [error, hash] = hashes[index];
      if (error) {
        throw error;
      }
      if (!existing.has(clientId)) {
        return [];
      }
      return Object.entries(hash as Record<string, string>)
        .filter(([route]) => route !== TOTAL_FIELD)
        .map(([route, count]) => ({
          clientId,
          day,
          route,
          count: Number(count),
        }));
    });
    // In batches: a parameter list has its limits.
    for (let start = 0; start < rows.length; start += 1000) {
      await this.db
        .insert(apiUsage)
        .values(rows.slice(start, start + 1000))
        .onConflictDoUpdate({
          target: [
            apiUsage.tenantId,
            apiUsage.clientId,
            apiUsage.day,
            apiUsage.route,
          ],
          set: { count: sql`excluded.count`, updatedAt: new Date() },
        });
    }
    // Today's counters keep counting: the rows are a copy, the next run overwrites them.
    if (day < utcDay(now)) {
      await this.redis.del(...found.map(({ key }) => key));
    }
    return rows.length;
  }

  /**
   * The usage keys matching `pattern`, without REDIS_PREFIX. SCAN's pattern
   * and its answers carry the prefix: ioredis's keyPrefix leaves them alone.
   */
  private async liveKeys(pattern: string) {
    const prefix = `${this.config.get('REDIS_PREFIX', { infer: true })}:`;
    const keys: UsageKey[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `${prefix}${pattern}`,
        'COUNT',
        500,
      );
      cursor = next;
      for (const full of batch) {
        const key = full.slice(prefix.length);
        const parsed = parseUsageKey(key);
        if (parsed) {
          keys.push({ key, ...parsed });
        }
      }
    } while (cursor !== '0');
    return keys;
  }
}
