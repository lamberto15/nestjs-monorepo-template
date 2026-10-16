import { Injectable } from '@nestjs/common';
import { Realtime } from '../../realtime/realtime.service.js';
import { NotificationChannelRegistry } from '../notification-channel.registry.js';
import {
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationDelivery,
} from '../notification.types.js';
import { NotificationsService } from '../notifications.service.js';

/**
 * The recipient's open connections hear of the notification at once: the
 * `notification` event, with the item as GET /notifications shows it, in
 * the recipient's language, then the new unread count. Always on (not a
 * preference); best-effort, as realtime is: a retried delivery may emit
 * it again.
 */
@Injectable()
export class RealtimeChannel implements NotificationChannel {
  readonly name = 'realtime';

  constructor(
    private readonly realtime: Realtime,
    private readonly notifications: NotificationsService,
    registry: NotificationChannelRegistry,
  ) {
    registry.register(this);
  }

  supports() {
    return true;
  }

  async afterCommit({
    notification,
    recipient,
    rendered,
  }: NotificationDelivery) {
    this.realtime.toPrincipal(
      recipient,
      NOTIFICATION_EVENTS.created,
      this.notifications.view(notification, rendered.locale),
    );
    await this.notifications.announceUnread(recipient);
  }
}
