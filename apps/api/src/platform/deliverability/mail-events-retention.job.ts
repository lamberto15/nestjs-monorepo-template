import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { lt } from 'drizzle-orm';
import { deleteInBatches } from '../../core/database/batched-delete.js';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { MAIL_EVENTS_RETENTION_JOB } from '../platform.jobs.js';
import type { PlatformEnv } from '../platform.env.js';
import { mailEvents } from './deliverability.tables.js';

/**
 * Deletes bounce, complaint and delivery events older than
 * MAIL_EVENTS_RETENTION_DAYS every night at 03:40 in APP_TIMEZONE, on one
 * instance. The suppression list itself is kept: an entry stays until an
 * administrator removes it.
 */
@Injectable()
export class MailEventsRetentionJob {
  private readonly logger = new Logger('MailEvents');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
  ) {}

  @Cron('40 3 * * *', {
    name: 'mail-events-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'mail-events:retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      MAIL_EVENTS_RETENTION_JOB,
      async () => {
        const days = this.config.get('MAIL_EVENTS_RETENTION_DAYS', {
          infer: true,
        });
        const deleted = await deleteInBatches(
          this.txHost,
          mailEvents,
          mailEvents.id,
          lt(mailEvents.createdAt, new Date(now.getTime() - days * 86_400_000)),
        );
        this.logger.log('Old mail events deleted', {
          deleted,
          days,
        });
        return deleted;
      },
      // A global table (every tenant's mail together): no tenant.
      { transaction: false, tenantId: null },
    );
  }
}
