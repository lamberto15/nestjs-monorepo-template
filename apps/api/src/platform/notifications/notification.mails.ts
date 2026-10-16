import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';

/** One notification, mailed at once. */
export interface NotificationMailData {
  name: string;
  title: string;
  body: string;
  /** Where to go about it: a path of the web app, or null. */
  link: string | null;
}

/** Several notifications, bundled: an hourly or daily digest. */
export interface NotificationDigestData {
  name: string;
  items: {
    title: string;
    body: string;
    link: string | null;
    /** When it happened. */
    at: Date;
  }[];
  /** How many the digest stands for (the items, plus `more` not listed). */
  count: number;
  more: number;
  /** The recipient's time zone (null: APP_TIMEZONE): times are shown in it. */
  timezone: string | null;
}

/** What the two mails share: the app's name and web address, the recipient's language. */
@Injectable() // Nest reads the subclasses' dependencies from here.
abstract class NotificationMailable {
  constructor(
    protected readonly i18n: I18nService,
    protected readonly config: ConfigService<CoreEnv, true>,
  ) {}

  protected get app() {
    return this.config.get('SERVICE_NAME', { infer: true });
  }

  /** A notification's link as an absolute URL of the web app (null without one). */
  protected url(link: string | null) {
    const web = webUrl(this.config);
    return link && web ? `${web}${link}` : null;
  }
}

/** A notification sent at once (`email: 'immediate'`): its title is the subject. */
@Injectable()
export class NotificationMail
  extends NotificationMailable
  implements Mailable<NotificationMailData>
{
  render(
    { name, title, body, link }: NotificationMailData,
    { locale }: MailRenderContext,
  ) {
    return {
      subject: this.i18n.t('mail.notification.subject', {
        locale,
        args: { title },
      }),
      template: 'notification',
      context: { name, title, body, url: this.url(link), app: this.app },
    };
  }
}

/** The notifications of an hour or a day in one mail (`email: 'hourly' | 'daily'`). */
@Injectable()
export class NotificationDigestMail
  extends NotificationMailable
  implements Mailable<NotificationDigestData>
{
  render(
    { name, items, count, more, timezone }: NotificationDigestData,
    { locale }: MailRenderContext,
  ) {
    const timeZone =
      timezone ?? this.config.get('APP_TIMEZONE', { infer: true });
    return {
      subject: this.i18n.t('mail.notificationDigest.subject', {
        locale,
        args: { count, app: this.app },
      }),
      template: 'notification-digest',
      context: {
        name,
        count,
        more,
        app: this.app,
        items: items.map((item) => ({
          title: item.title,
          body: item.body,
          url: this.url(item.link),
          at: this.i18n.formatDate(item.at, {
            locale,
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone,
          }),
        })),
      },
    };
  }
}
