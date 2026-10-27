import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { abortable } from '../../../core/queues/abortable.js';
import { NotificationChannelRegistry } from '../../notifications/notification-channel.registry.js';
import type {
  NotificationChannel,
  NotificationDelivery,
} from '../../notifications/notification.types.js';
import { clip } from '../messaging.policy.js';
import { MESSAGING, type SmsJob } from '../messaging.queue.js';
import { MessagingService } from '../messaging.service.js';
import { SMS_PROVIDER, type SmsProvider } from '../providers/sms-provider.js';

declare module '../../notifications/notification.types.js' {
  interface NotificationChannelSettings {
    /** Users only: whether the notification is also texted to their verified number. */
    sms: boolean;
  }
}

/**
 * SMS, for users with a verified number that has not opted out, when they
 * switched it on for the type (a preference, off unless the type's default
 * says otherwise). The channel only queues; the worker applies the kill
 * switch and the toll-fraud caps and sends (messaging.processor.ts), so a
 * slow or failing provider never holds the delivery. The job id is the
 * notification's: a retried delivery queues it once. Not offered at all
 * (not a preference) while SMS_PROVIDER is `off`.
 */
@Injectable()
export class SmsChannel implements NotificationChannel<boolean> {
  readonly name = 'sms';
  readonly settings = { schema: z.boolean(), off: false };

  constructor(
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider | null,
    @InjectQueue(MESSAGING) private readonly queue: Queue,
    private readonly messaging: MessagingService,
    registry: NotificationChannelRegistry,
  ) {
    registry.register(this);
  }

  supports(recipient: NotificationDelivery['recipient']) {
    return this.provider !== null && recipient.kind === 'user';
  }

  // Before the transaction: the add waits on Redis, and must not hold a connection.
  async beforeTransaction(
    {
      notification,
      recipient,
      setting,
      rendered,
      quietUntil,
    }: NotificationDelivery,
    signal: AbortSignal,
  ) {
    if (recipient.kind !== 'user' || setting !== true) return;
    if (!(await this.messaging.hasSendablePhone(recipient.id))) return;
    // An account's own notification has no tenant; the caps are the user's tenant's.
    const tenantId = notification.tenantId ?? recipient.tenantId;
    if (!tenantId) return;
    const job: SmsJob = {
      kind: 'sms',
      tenantId,
      userId: recipient.id,
      notificationId: notification.id,
      text: clip(`${rendered.title}: ${rendered.body}`, 1600),
    };
    await abortable(
      signal,
      this.queue.add('sms', job, {
        jobId: `sms-${notification.id}`,
        // Quiet hours: texted when they end.
        ...(quietUntil
          ? { delay: Math.max(0, quietUntil.getTime() - Date.now()) }
          : {}),
      }),
    );
  }
}
