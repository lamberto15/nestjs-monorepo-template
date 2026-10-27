import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { WebhookDeliveries } from '@nestjs/webhooks';
import { eq, notExists } from 'drizzle-orm';
import { deleteInBatches } from '../../core/database/batched-delete.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { WEBHOOK_DELIVERY_RETENTION_JOB } from '../platform.jobs.js';
import type { PlatformEnv } from '../platform.env.js';
import { storeDeliveries } from './webhook-store.view.js';
import { webhookDeliveryRequests } from './webhooks.tables.js';

/**
 * Deletes finished outgoing webhook deliveries (succeeded, or failed for
 * good) that finished more than WEBHOOKS_DELIVERY_RETENTION_DAYS ago, every
 * night at 03:35 in APP_TIMEZONE, on one instance; a delivery still
 * pending (waiting for a retry, or being sent) is never touched. The
 * package does the pruning (`WebhookDeliveries.prune()`: the deliveries,
 * their attempt log and the messages left without a delivery); this job
 * then deletes the `webhook_delivery_requests` rows (the recorded request
 * headers, recording.transport.ts) whose delivery no longer exists, which
 * the package knows nothing of.
 *
 * Both tables are global (the package's store has no row-level security,
 * the request rows no tenant), one rule for every tenant: no tenant, no
 * bypass, as the mail events' retention. Left out with WEBHOOKS=off.
 */
@Injectable()
export class WebhookDeliveryRetentionJob {
  private readonly logger = new Logger('Webhooks');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly deliveries: WebhookDeliveries,
  ) {}

  /** Returns how many deliveries and recorded requests were deleted. */
  @Cron('35 3 * * *', {
    name: 'webhook-delivery-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'webhooks:delivery-retention' })
  @WithoutOverlapping()
  run() {
    return this.system.run(
      WEBHOOK_DELIVERY_RETENTION_JOB,
      async () => {
        const days = this.config.get('WEBHOOKS_DELIVERY_RETENTION_DAYS', {
          infer: true,
        });
        const deliveries = await this.deliveries.prune(`${days}d`);
        // After the package: a request row outlives its delivery by no more than a night.
        const requests = await deleteInBatches(
          this.txHost,
          webhookDeliveryRequests,
          webhookDeliveryRequests.deliveryId,
          notExists(
            this.db
              .select({ one: storeDeliveries.id })
              .from(storeDeliveries)
              .where(
                eq(storeDeliveries.id, webhookDeliveryRequests.deliveryId),
              ),
          ),
        );
        this.logger.log('Old webhook deliveries deleted', {
          deliveries,
          requests,
          days,
        });
        return { deliveries, requests };
      },
      // Global tables (every tenant's deliveries together): no tenant.
      { transaction: false, tenantId: null },
    );
  }
}
