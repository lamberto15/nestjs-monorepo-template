import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { inTenantOf } from '../../../core/tenancy/tenant-job.js';
import { principalKey } from '../../../iam/auth/principal.js';
import { SystemContext } from '../../../iam/access/system-context.js';
import { NOTIFICATION_DELIVERY_JOB } from '../../platform.jobs.js';
import { Realtime } from '../../realtime/realtime.service.js';
import { NotificationChannelRegistry } from '../notification-channel.registry.js';
import {
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationDelivery,
} from '../notification.types.js';
import { NotificationsService } from '../notifications.service.js';

/** Deliveries to one recipient announce their unread count at most this often. */
export const UNREAD_ANNOUNCE_WINDOW_MS = 1_000;

/**
 * The recipient's open connections hear of the notification at once: the
 * `notification` event, with the item as GET /notifications shows it, in
 * the recipient's language. The new unread count follows, at most once a
 * second per recipient (a backlog would otherwise count and push for every
 * delivery); per process, which is fine for a best-effort badge. Always on
 * (not a preference); best-effort, as realtime is: a retried delivery may
 * emit it again.
 */
@Injectable()
export class RealtimeChannel implements NotificationChannel, OnModuleDestroy {
  readonly name = 'realtime';
  private readonly logger = new Logger(RealtimeChannel.name);
  // Custom: no NestJS or outbox feature coalesces socket emits.
  private readonly announcing = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly realtime: Realtime,
    private readonly notifications: NotificationsService,
    private readonly system: SystemContext,
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
    const key = `${notification.tenantId ?? ''}|${principalKey(recipient)}`;
    if (this.announcing.has(key)) return; // the timer reads the count when it fires
    const timer = setTimeout(() => {
      this.announcing.delete(key);
      // The delivery's transaction and context are gone: enter the tenant's again.
      inTenantOf({ tenantId: notification.tenantId }, () =>
        this.system.run(
          NOTIFICATION_DELIVERY_JOB,
          () => this.notifications.announceUnread(recipient),
          { transaction: false },
        ),
      ).catch((error: unknown) =>
        this.logger.warn(`Unread count not announced: ${String(error)}`),
      );
    }, UNREAD_ANNOUNCE_WINDOW_MS);
    timer.unref();
    this.announcing.set(key, timer);
  }

  onModuleDestroy() {
    for (const timer of this.announcing.values()) clearTimeout(timer);
    this.announcing.clear();
  }
}
