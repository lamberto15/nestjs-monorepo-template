import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { eq, like, sql } from 'drizzle-orm';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { utcDay } from './messaging.policy.js';
import { messagingUsage } from './messaging.tables.js';

/**
 * `sms_sent_today` and `sms_blocked_today{reason}` on the workers' `/metrics`
 * (every tenant's counters, UTC day): the first is the spend, the second the
 * toll-fraud caps and the allowlist refusing. Alert on a blocked count
 * rising, or the sent count passing what the deployment expects
 * (docs/notifications.md, "Push and SMS").
 */
@Injectable()
export class MessagingMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
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
  }
}
