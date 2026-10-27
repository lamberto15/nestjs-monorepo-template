import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, eq, lt, ne, or } from 'drizzle-orm';
import { deleteInBatches } from '../../core/database/batched-delete.js';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { MESSAGING_RETENTION_JOB } from '../platform.jobs.js';
import type { PlatformEnv } from '../platform.env.js';
import { previousMonthStart, utcDay } from './messaging.policy.js';
import { MessagingService } from './messaging.service.js';
import { messagingUsage } from './messaging.tables.js';

/**
 * Every night at 03:45 in APP_TIMEZONE, on one instance: removes the devices
 * not seen for DEVICES_RETENTION_DAYS (a phone gone, an app uninstalled: its
 * provider never said so) and the cap counters of days before yesterday
 * (the counters are per UTC day; yesterday's stay for the metrics) and the
 * monthly spend of months before the last.
 */
@Injectable()
export class MessagingRetentionJob {
  private readonly logger = new Logger('Messaging');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
    private readonly messaging: MessagingService,
  ) {}

  @Cron('45 3 * * *', {
    name: 'messaging-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'messaging:retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      MESSAGING_RETENTION_JOB,
      () =>
        this.tenancy.bypass(MESSAGING_RETENTION_JOB.key, async () => {
          const days = this.config.get('DEVICES_RETENTION_DAYS', {
            infer: true,
          });
          const devices = await this.messaging.removeStaleDevices(
            new Date(now.getTime() - days * 86_400_000),
          );
          const counters = await deleteInBatches(
            this.txHost,
            messagingUsage,
            messagingUsage.id,
            or(
              // The daily counters are of yesterday and before ...
              and(
                ne(messagingUsage.counter, 'spend'),
                lt(
                  messagingUsage.day,
                  utcDay(new Date(now.getTime() - 86_400_000)),
                ),
              ),
              // ... the month's spend stays through the next month (for the alert's history).
              and(
                eq(messagingUsage.counter, 'spend'),
                lt(messagingUsage.day, previousMonthStart(now)),
              ),
            ),
          );
          this.logger.log('Messaging swept', {
            devices,
            counters,
            days,
          });
          return { devices, counters };
        }),
      { transaction: false },
    );
  }
}
