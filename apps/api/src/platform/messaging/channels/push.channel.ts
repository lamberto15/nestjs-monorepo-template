import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { NotificationChannelRegistry } from '../../notifications/notification-channel.registry.js';
import type {
  NotificationChannel,
  NotificationDelivery,
} from '../../notifications/notification.types.js';
import { MESSAGING, type PushJob } from '../messaging.queue.js';
import { MessagingService } from '../messaging.service.js';
import {
  PUSH_PROVIDER,
  type PushProvider,
} from '../providers/push-provider.js';

declare module '../../notifications/notification.types.js' {
  interface NotificationChannelSettings {
    /** Users only: whether the notification is also pushed to their registered devices. */
    push: boolean;
  }
}

/**
 * Push, for users with a registered device, when they switched it on for
 * the type. Queues one job per device (the device's own retries and its own
 * dead-token cleanup); the worker sends. Not offered at all while
 * PUSH_PROVIDER is `off`.
 */
@Injectable()
export class PushChannel implements NotificationChannel<boolean> {
  readonly name = 'push';
  readonly settings = { schema: z.boolean(), off: false };

  constructor(
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider | null,
    @InjectQueue(MESSAGING) private readonly queue: Queue,
    private readonly messaging: MessagingService,
    registry: NotificationChannelRegistry,
  ) {
    registry.register(this);
  }

  supports(recipient: NotificationDelivery['recipient']) {
    return this.provider !== null && recipient.kind === 'user';
  }

  async inTransaction({
    notification,
    recipient,
    setting,
    rendered,
    quietUntil,
  }: NotificationDelivery) {
    if (recipient.kind !== 'user' || setting !== true) return;
    const tenantId = notification.tenantId ?? recipient.tenantId;
    if (!tenantId) return;
    for (const deviceId of await this.messaging.deviceIdsOf(recipient.id)) {
      const job: PushJob = {
        kind: 'push',
        tenantId,
        deviceId,
        notificationId: notification.id,
        title: rendered.title,
        body: rendered.body,
        link: notification.link,
      };
      await this.queue.add('push', job, {
        jobId: `push-${notification.id}-${deviceId}`,
        // Quiet hours: pushed when they end.
        ...(quietUntil
          ? { delay: Math.max(0, quietUntil.getTime() - Date.now()) }
          : {}),
      });
    }
  }
}
