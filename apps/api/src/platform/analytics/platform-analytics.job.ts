import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, count, countDistinct, eq, gte, sql, sum } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import {
  apiClients,
  memberships,
  sessions,
  users,
} from '../../iam/iam.tables.js';
import type { PlatformEnv } from '../platform.env.js';
import { PLATFORM_ANALYTICS_JOB } from '../platform.jobs.js';
import { apiUsage } from '../usage/usage.tables.js';
import { addDays, utcDay } from '../usage/usage-keys.js';
import { platformMetrics } from './analytics.tables.js';
import { type Figure, suppressSmallGroups } from './suppression.js';

/** The active members a tenant has, in buckets: `tenants.by_members`. */
const MEMBER_BUCKETS: [label: string, max: number][] = [
  ['0', 0],
  ['1', 1],
  ['2-10', 10],
  ['11-50', 50],
  ['51-250', 250],
  ['251+', Number.POSITIVE_INFINITY],
];

/** A user counts as recently active when a session of theirs was used this many days back. */
const RECENT_DAYS = 30;

/**
 * Platform analytics (docs/tenancy.md, "Platform analytics"; roadmap 1b):
 * every night at 00:40 UTC (after the usage roll-up), on one instance,
 * counts across every tenant under the worker's row-level security bypass
 * (`Tenancy.bypass()`, the maintenance role), withholds the small groups
 * (`suppressSmallGroups()`, ANALYTICS_MIN_GROUP_SIZE) and stores only the
 * resulting figures in `analytics.platform_metrics`, the one table the
 * reporting role (POSTGRES_REPORTING_USER) may read. No tenant, user or
 * client id leaves the bypass, only counts. Running again the same day
 * overwrites that day's figures.
 */
@Injectable()
export class PlatformAnalyticsJob {
  private readonly logger = new Logger('Analytics');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  /** Snapshots the platform as of `now`, stored under its UTC day. Returns the figures stored. */
  @Cron('40 0 * * *', { name: 'platform-analytics', timeZone: 'UTC' })
  @OnOneInstance({ key: 'analytics:snapshot' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      PLATFORM_ANALYTICS_JOB,
      () =>
        this.tenancy.bypass(PLATFORM_ANALYTICS_JOB.key, async () => {
          const minGroupSize = this.config.get('ANALYTICS_MIN_GROUP_SIZE', {
            infer: true,
          });
          const day = utcDay(now);
          const figures = suppressSmallGroups(
            await this.count(day, now),
            minGroupSize,
          );
          await this.db
            .insert(platformMetrics)
            .values(figures.map((figure) => ({ day, ...figure })))
            .onConflictDoUpdate({
              target: [
                platformMetrics.day,
                platformMetrics.metric,
                platformMetrics.dimension,
              ],
              set: { value: sql`excluded.value`, updatedAt: new Date() },
            });
          this.logger.log('Platform analytics stored', {
            day,
            figures: figures.length,
            suppressed: figures.filter((figure) => figure.value === null)
              .length,
            minGroupSize,
          });
          return figures;
        }),
      { transaction: false },
    );
  }

  /** The raw counts of the snapshot, before suppression: never stored as they are. */
  private async count(day: string, now: Date): Promise<Figure[]> {
    const total = (metric: string, value: number | string | null) => ({
      metric,
      dimension: '',
      count: Number(value ?? 0),
    });
    const [activeTenants] = await this.db
      .select({ n: count() })
      .from(tenants)
      .where(eq(tenants.active, true));
    const [activeUsers] = await this.db
      .select({ n: count() })
      .from(users)
      .where(eq(users.active, true));
    const [recentUsers] = await this.db
      .select({ n: countDistinct(sessions.userId) })
      .from(sessions)
      .where(
        gte(
          sessions.lastActiveAt,
          new Date(now.getTime() - RECENT_DAYS * 86_400_000),
        ),
      );
    const liveMembership = and(
      eq(memberships.active, true),
      eq(users.active, true),
    );
    const [activeMemberships] = await this.db
      .select({ n: count() })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(liveMembership, eq(tenants.active, true)));
    const [activeClients] = await this.db
      .select({ n: count() })
      .from(apiClients)
      .where(eq(apiClients.active, true));
    const [requests] = await this.db
      .select({ n: sum(apiUsage.count) })
      .from(apiUsage)
      .where(eq(apiUsage.day, addDays(day, -1)));
    const members = await this.db
      .select({ n: count(users.id) })
      .from(tenants)
      .leftJoin(memberships, eq(memberships.tenantId, tenants.id))
      .leftJoin(users, and(eq(users.id, memberships.userId), liveMembership))
      .where(eq(tenants.active, true))
      .groupBy(tenants.id);
    const byMembers = new Map<string, number>();
    for (const { n } of members) {
      const [label] = MEMBER_BUCKETS.find(([, max]) => n <= max)!;
      byMembers.set(label, (byMembers.get(label) ?? 0) + 1);
    }
    const locale = sql<string>`coalesce(${users.locale}, 'unset')`;
    const byLocale = await this.db
      .select({ locale, n: count() })
      .from(users)
      .where(eq(users.active, true))
      .groupBy(locale);
    return [
      total('tenants.active', activeTenants?.n ?? 0),
      total('users.active', activeUsers?.n ?? 0),
      total(`users.active_${RECENT_DAYS}d`, recentUsers?.n ?? 0),
      total('memberships.active', activeMemberships?.n ?? 0),
      total('api_clients.active', activeClients?.n ?? 0),
      total('api_requests.previous_day', requests?.n ?? 0),
      ...MEMBER_BUCKETS.filter(([label]) => byMembers.has(label)).map(
        ([label]) => ({
          metric: 'tenants.by_members',
          dimension: label,
          count: byMembers.get(label)!,
        }),
      ),
      ...byLocale.map(({ locale, n }) => ({
        metric: 'users.by_locale',
        dimension: locale,
        count: n,
      })),
    ];
  }
}
