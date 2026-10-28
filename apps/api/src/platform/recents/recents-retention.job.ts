import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { lt } from 'drizzle-orm';
import { deleteInBatches } from '../../core/database/batched-delete.js';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { RECENTS_RETENTION_JOB } from '../platform.jobs.js';
import { RECENTS_RETENTION_DAYS } from './recent.schemas.js';
import { recentRecords } from './recents.tables.js';

/**
 * Deletes recent records older than RECENTS_RETENTION_DAYS, every night at
 * 03:40 in APP_TIMEZONE, on one instance: a sweep by age for every tenant,
 * under the worker's row-level security bypass (as NotificationRetentionJob).
 */
@Injectable()
export class RecentsRetentionJob {
  private readonly logger = new Logger('Recents');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('40 3 * * *', {
    name: 'recents-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'recents:retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      RECENTS_RETENTION_JOB,
      () =>
        this.tenancy.bypass(RECENTS_RETENTION_JOB.key, async () => {
          const before = new Date(
            now.getTime() - RECENTS_RETENTION_DAYS * 86_400_000,
          );
          const deleted = await deleteInBatches(
            this.txHost,
            recentRecords,
            recentRecords.id,
            lt(recentRecords.viewedAt, before),
          );
          this.logger.log('Old recent records deleted', { deleted });
          return deleted;
        }),
      { transaction: false },
    );
  }
}
