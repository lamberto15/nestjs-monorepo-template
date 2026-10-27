import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, isNotNull, lt, or } from 'drizzle-orm';
import { deleteInBatches } from '../../core/database/batched-delete.js';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import type { PlatformEnv } from '../platform.env.js';
import { notifications } from './notifications.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { NOTIFICATION_RETENTION_JOB } from '../platform.jobs.js';

/**
 * Deletes read notifications older than NOTIFICATIONS_RETENTION_DAYS and
 * any older than NOTIFICATIONS_MAX_AGE_DAYS, every night at 03:30 in
 * APP_TIMEZONE, on one instance. A sweep of the whole table by age, the
 * same rule for every tenant (and the accounts' own rows): under the
 * worker's row-level security bypass (`Tenancy.bypass()`, docs/tenancy.md)
 * rather than one pass per tenant.
 */
@Injectable()
export class NotificationRetentionJob {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('30 3 * * *', {
    name: 'notification-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'notifications:retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      NOTIFICATION_RETENTION_JOB,
      () =>
        this.tenancy.bypass(NOTIFICATION_RETENTION_JOB.key, async () => {
          const readDays = this.config.get('NOTIFICATIONS_RETENTION_DAYS', {
            infer: true,
          });
          const maxDays = this.config.get('NOTIFICATIONS_MAX_AGE_DAYS', {
            infer: true,
          });
          const before = (days: number) =>
            new Date(now.getTime() - days * 86_400_000);
          const deleted = await deleteInBatches(
            this.txHost,
            notifications,
            notifications.id,
            or(
              and(
                isNotNull(notifications.readAt),
                lt(notifications.readAt, before(readDays)),
              ),
              lt(notifications.createdAt, before(maxDays)),
            ),
          );
          this.logger.log('Old notifications deleted', {
            deleted,
            readDays,
            maxDays,
          });
          return deleted;
        }),
      { transaction: false },
    );
  }
}
