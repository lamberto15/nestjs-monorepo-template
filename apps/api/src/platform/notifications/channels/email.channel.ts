import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import type { CoreEnv } from '../../../core/config/core.env.js';
import type { Transaction } from '../../../core/database/drizzle.js';
import { MailQueue } from '../../../core/mail/mail-queue.js';
import type { PlatformEnv } from '../../platform.env.js';
import { nextDigestTime } from '../digest-time.js';
import { NotificationChannelRegistry } from '../notification-channel.registry.js';
import { NotificationMail } from '../notification.mails.js';
import { emailSettingSchema } from '../notification.schemas.js';
import type {
  EmailMode,
  NotificationChannel,
  NotificationDelivery,
} from '../notification.types.js';
import { notifications } from '../notifications.tables.js';

/**
 * Mail, for users: at once (`immediate`), or bundled by the digest job
 * (`hourly`, `daily`: the notification is flagged with when its digest is
 * due). The mail's job id is the notification's, so a retried delivery
 * queues it once.
 */
@Injectable()
export class EmailChannel implements NotificationChannel<EmailMode | false> {
  readonly name = 'email';
  readonly settings = {
    schema: emailSettingSchema,
    off: false as const,
  };

  constructor(
    private readonly mailQueue: MailQueue,
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    registry: NotificationChannelRegistry,
  ) {
    registry.register(this);
  }

  supports(recipient: NotificationDelivery['recipient']) {
    return recipient.kind === 'user';
  }

  async inTransaction(
    { notification, recipient, setting, rendered }: NotificationDelivery,
    tx: Transaction,
  ) {
    const mode = setting as EmailMode | false;
    if (recipient.kind !== 'user' || !mode) {
      return;
    }
    if (mode === 'immediate') {
      await this.mailQueue.send(
        NotificationMail,
        {
          to: { name: recipient.name, address: recipient.email },
          data: {
            name: recipient.name,
            title: rendered.title,
            body: rendered.body,
            link: notification.link,
          },
          locale: rendered.locale,
        },
        { jobId: `notification-${notification.id}` },
      );
      await tx
        .update(notifications)
        .set({ emailedAt: new Date() })
        .where(eq(notifications.id, notification.id));
      return;
    }
    const now = new Date();
    await tx
      .update(notifications)
      .set({
        digest: mode,
        digestDueAt: nextDigestTime(
          mode,
          now,
          recipient.timezone ??
            this.config.get('APP_TIMEZONE', { infer: true }),
          this.config.get('NOTIFICATIONS_DIGEST_HOUR', { infer: true }),
        ),
      })
      .where(eq(notifications.id, notification.id));
  }
}
