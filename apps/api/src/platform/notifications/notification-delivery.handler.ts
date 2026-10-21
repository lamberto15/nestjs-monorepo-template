import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import {
  NonRetryableMessageError,
  OnOutboxMessage,
  type OutboxHandlerContext,
} from '@nestjs/outbox';
import { eq } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../../iam/access/system-context.js';
import type { Principal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { apiClients } from '../../iam/iam.tables.js';
import { NotificationCatalog } from './notification-catalog.js';
import { NotificationChannelRegistry } from './notification-channel.registry.js';
import { same } from './notification-preferences.js';
import { quietUntil } from './quiet-hours.js';
import {
  NOTIFICATIONS_TOPIC,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationMessage,
} from './notification.types.js';
import { NOTIFICATION_DELIVERY_JOB } from '../platform.jobs.js';
import { notifications } from './notifications.tables.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Delivers a stored notification through its channels, on a worker, once
 * the transaction that created it committed (the outbox relay hands it
 * over; `OutboxRelay.runOnce()` in tests). Exactly once: the channels'
 * transactional effects commit with the inbox record and `delivered_at`;
 * a crash before that commit repeats the whole, after it nothing. A
 * failure retries the message (then a dead letter in GET /ops/outbox).
 * As the system principal (`system:notification-delivery`), in the
 * tenant the message names (`inTenantOf`, none for an account's own): what
 * the channels do runs in that context, so a realtime event reaches the
 * recipient's sockets in that tenant only (or their account room).
 */
@Injectable()
export class NotificationDeliveryHandler {
  private readonly logger = new Logger('Notifications');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly catalog: NotificationCatalog,
    private readonly registry: NotificationChannelRegistry,
    private readonly notifications: NotificationsService,
    private readonly users: UsersRepository,
    private readonly i18n: I18nService,
    private readonly system: SystemContext,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  @OnOutboxMessage(NOTIFICATIONS_TOPIC, { consumer: 'notifications' })
  deliver(
    payload: NotificationMessage,
    ctx: OutboxHandlerContext<Transaction>,
  ) {
    return inTenantOf(payload, () => this.deliverInTenant(payload, ctx));
  }

  private deliverInTenant(
    payload: NotificationMessage,
    ctx: OutboxHandlerContext<Transaction>,
  ) {
    return this.system.run(
      NOTIFICATION_DELIVERY_JOB,
      async () => {
        const [row] = await this.db
          .select()
          .from(notifications)
          .where(eq(notifications.id, payload.notificationId));
        if (!row || row.deliveredAt) {
          return; // collapsed away or removed since; or delivered before a crash
        }
        const declaration = this.catalog.declaration(row.type);
        if (!declaration) {
          throw new NonRetryableMessageError(
            `Notification type "${row.type}" is no longer declared.`,
          );
        }
        const recipient = await this.recipient(row.recipient, payload.tenantId);
        if (!recipient) {
          // Deactivated since: the stored notification stays, nothing is sent.
          await this.db
            .update(notifications)
            .set({ deliveredAt: new Date() })
            .where(eq(notifications.id, row.id));
          return;
        }
        const overrides = await this.notifications.overrides(row.recipient);
        const settings = this.catalog.effective(
          declaration,
          overrides[row.type],
          recipient,
        );
        const locale =
          recipient.kind === 'user' && recipient.locale
            ? recipient.locale
            : this.i18n.defaultLocale;
        const rendered = {
          locale,
          ...this.catalog.render(row.type, row.data, row.count, locale),
        };
        // Quiet hours hold back what disturbs (push, SMS), but not an urgent type.
        const quiet =
          recipient.kind === 'user' && !declaration.urgent
            ? quietUntil(
                new Date(),
                await this.notifications.quietHoursOf(row.recipient),
                recipient.timezone ??
                  this.config.get('APP_TIMEZONE', { infer: true }),
              )
            : null;
        const deliveries: {
          channel: NotificationChannel;
          delivery: NotificationDelivery;
        }[] = [];
        for (const channel of this.registry.all()) {
          if (!channel.supports(recipient)) continue;
          const setting = channel.settings ? settings[channel.name] : true;
          if (channel.settings && same(setting, channel.settings.off)) continue;
          deliveries.push({
            channel,
            delivery: {
              notification: row,
              recipient,
              setting,
              rendered,
              ...(quiet ? { quietUntil: quiet } : {}),
            },
          });
        }
        const result = await inTransaction(this.txHost, async (tx) =>
          ctx.processInTransaction(tx, async () => {
            for (const { channel, delivery } of deliveries) {
              await channel.inTransaction?.(delivery, tx);
            }
            await tx
              .update(notifications)
              .set({ deliveredAt: new Date() })
              .where(eq(notifications.id, row.id));
          }),
        );
        if (result.duplicate) {
          return;
        }
        for (const { channel, delivery } of deliveries) {
          try {
            await channel.afterCommit?.(delivery);
          } catch (error) {
            // The notification is stored and the transactional channels done:
            // a socket emit that failed is not worth a retry of the whole.
            this.logger.warn(
              `The ${channel.name} channel failed after the commit`,
              {
                notificationId: row.id,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      },
      { transaction: false },
    );
  }

  /**
   * The recipient as they are now: null when deactivated (or revoked) since,
   * or no longer a member of the notification's tenant (a person who left
   * a tenant hears nothing more of it).
   */
  private async recipient(
    key: string,
    tenantId: string | null,
  ): Promise<Principal | null> {
    const [kind, id] = key.split(':') as [string, string];
    if (kind === 'user') {
      const user = await this.users.inTenant(id, tenantId);
      return user && (!tenantId || user.tenantId === tenantId) ? user : null;
    }
    if (kind !== 'client' || !tenantId) {
      // The system has no inbox (notify() never stores one for it); an API
      // client belongs to a tenant, so it has nothing outside one.
      return null;
    }
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    // The client is read in the message's tenant (row-level security): one
    // of another tenant, or none at all outside a tenant, is nobody.
    return client?.active
      ? {
          kind: 'client',
          id: client.id,
          name: client.name,
          tenantId: client.tenantId,
        }
      : null;
  }
}
