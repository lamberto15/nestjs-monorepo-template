import { Injectable } from '@nestjs/common';
import { Webhooks } from '@nestjs/webhooks';
import { z } from 'zod';
import type { Transaction } from '../../../core/database/drizzle.js';
import { NotificationChannelRegistry } from '../notification-channel.registry.js';
import {
  NOTIFICATION_WEBHOOK_EVENT,
  type NotificationChannel,
  type NotificationDelivery,
} from '../notification.types.js';
import { NotificationsService } from '../notifications.service.js';

/**
 * A webhook, for API clients: the `notification.created` event, with the
 * item as GET /notifications shows it (`type` and `data` are the contract;
 * the texts are in the default language). Dispatched in the delivery's
 * transaction, through the outbox, like a feature's own events.
 */
@Injectable()
export class WebhookChannel implements NotificationChannel<boolean> {
  readonly name = 'webhook';
  readonly settings = { schema: z.boolean(), off: false };

  constructor(
    private readonly webhooks: Webhooks<Transaction>,
    private readonly notifications: NotificationsService,
    registry: NotificationChannelRegistry,
  ) {
    registry.register(this);
  }

  supports(recipient: NotificationDelivery['recipient']) {
    return recipient.kind === 'client';
  }

  async inTransaction(
    { notification, recipient, setting, rendered }: NotificationDelivery,
    tx: Transaction,
  ) {
    if (recipient.kind !== 'client' || setting !== true) {
      return;
    }
    await this.webhooks.dispatch(tx, {
      type: NOTIFICATION_WEBHOOK_EVENT,
      tenant: recipient.id,
      data: this.notifications.view(notification, rendered.locale),
    });
  }

  async afterCommit() {
    this.webhooks.notify(); // deliver now instead of at the next poll
  }
}
