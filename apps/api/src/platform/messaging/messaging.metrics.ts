import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { eq, like, sql } from 'drizzle-orm';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import type { PlatformEnv } from '../platform.env.js';
import { utcDay, utcMonthStart } from './messaging.policy.js';
import { messagingUsage } from './messaging.tables.js';

/**
 * `sms_sent_today` and `sms_blocked_today{reason}` on the workers' `/metrics`
 * (every tenant's counters, UTC day): the first is the spend, the second the
 * toll-fraud caps and the allowlist refusing. Alert on a blocked count
 * rising, or the sent count passing what the deployment expects
 * (docs/notifications.md, "Push and SMS"). `sms_spend_month_minor` is the
 * month's spend of every tenant (minor units), and `sms_budget_used_ratio` the
 * largest share of SMS_MONTHLY_BUDGET_MINOR a tenant has used (none while there
 * is no budget).
 */
@Injectable()
export class MessagingMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  onModuleInit() {
    const db = () => database(this.txHost);
    this.metrics.collect(
      'sms_sent_today',
      'SMS sent today (UTC) by every tenant, counting each reserved against the caps.',
      async () => {
        const [row] = await db()
          .select({
            total: sql<number>`coalesce(sum(${messagingUsage.count}), 0)::int`,
          })
          .from(messagingUsage)
          .where(
            sql`${messagingUsage.day} = ${utcDay(new Date())} and ${eq(messagingUsage.counter, 'tenant')}`,
          );
        return [{ labels: {}, value: row?.total ?? 0 }];
      },
      [],
      { acrossTenants: true },
    );
    this.metrics.collect(
      'sms_blocked_today',
      'SMS refused today (UTC) by the toll-fraud caps or the country allowlist, by reason.',
      async () => {
        const rows = await db()
          .select({
            counter: messagingUsage.counter,
            total: sql<number>`sum(${messagingUsage.count})::int`,
          })
          .from(messagingUsage)
          .where(
            sql`${messagingUsage.day} = ${utcDay(new Date())} and ${like(messagingUsage.counter, 'blocked:%')}`,
          )
          .groupBy(messagingUsage.counter);
        return rows.map((row) => ({
          labels: { reason: row.counter.slice('blocked:'.length) },
          value: row.total,
        }));
      },
      ['reason'],
      { acrossTenants: true },
    );
    this.metrics.collect(
      'sms_spend_month_minor',
      'SMS spend this month (UTC) of every tenant, in minor units of the price table.',
      async () => {
        const [row] = await db()
          .select({
            total: sql<number>`coalesce(sum(${messagingUsage.count}), 0)::int`,
          })
          .from(messagingUsage)
          .where(
            sql`${messagingUsage.day} = ${utcMonthStart(new Date())} and ${eq(messagingUsage.counter, 'spend')}`,
          );
        return [{ labels: {}, value: row?.total ?? 0 }];
      },
      [],
      { acrossTenants: true },
    );
    this.metrics.collect(
      'sms_budget_used_ratio',
      'The largest share of the monthly SMS budget (SMS_MONTHLY_BUDGET_MINOR) a tenant has used this month; absent without a budget.',
      async () => {
        const budget = this.config.get('SMS_MONTHLY_BUDGET_MINOR', {
          infer: true,
        });
        if (budget <= 0) return [];
        const [row] = await db()
          .select({
            highest: sql<number>`coalesce(max(${messagingUsage.count}), 0)::int`,
          })
          .from(messagingUsage)
          .where(
            sql`${messagingUsage.day} = ${utcMonthStart(new Date())} and ${eq(messagingUsage.counter, 'spend')}`,
          );
        return [{ labels: {}, value: (row?.highest ?? 0) / budget }];
      },
      [],
      { acrossTenants: true },
    );
  }
}
