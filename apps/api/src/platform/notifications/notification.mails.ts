import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import type { PlatformEnv } from '../platform.env.js';
import {
  NotificationUnsubscribeLinks,
  unsubscribeHeaders,
} from './notification-unsubscribe.js';

/** One notification, mailed at once. */
export interface NotificationMailData {
  name: string;
  title: string;
  body: string;
  /** Where to go about it: a path of the web app, or null. */
  link: string | null;
  /**
   * The unsubscribe token (NotificationUnsubscribeLinks): the mail then
   * carries the one-click headers and a footer link. Null for a mandatory
   * type, which the person can't switch off.
   */
  unsubscribe: string | null;
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
  /** The unsubscribe token for the digest (null when it lists only mandatory types). */
  unsubscribe: string | null;
}

/** What the two mails share: the app's name and web address, the recipient's language. */
@Injectable() // Nest reads the subclasses' dependencies from here.
abstract class NotificationMailable {
  constructor(
    protected readonly i18n: I18nService,
    protected readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    protected readonly unsubscribeLinks: NotificationUnsubscribeLinks,
  ) {}

  /**
   * RFC 8058: `List-Unsubscribe` (https, and the mailbox when configured) and
   * `List-Unsubscribe-Post` for the one-click POST, and the web page of the
   * footer link (the page POSTs the token; a GET must change nothing, since
   * mail scanners follow links).
   */
  protected unsubscribe(token: string | null) {
    if (!token) {
      return { headers: {}, unsubscribeUrl: null };
    }
    const web = webUrl(this.config);
    return {
      headers: unsubscribeHeaders(
        this.unsubscribeLinks.url(token),
        this.config.get('MAIL_UNSUBSCRIBE_MAILTO', { infer: true }),
      ),
      unsubscribeUrl: web
        ? `${web}/unsubscribe?token=${encodeURIComponent(token)}`
        : null,
    };
  }

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
    { name, title, body, link, unsubscribe }: NotificationMailData,
    { locale }: MailRenderContext,
  ) {
    const { headers, unsubscribeUrl } = this.unsubscribe(unsubscribe);
    return {
      headers,
      subject: this.i18n.t('mail.notification.subject', {
        locale,
        args: { title },
      }),
      template: 'notification',
      context: {
        name,
        title,
        body,
        url: this.url(link),
        app: this.app,
        unsubscribeUrl,
      },
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
    { name, items, count, more, timezone, unsubscribe }: NotificationDigestData,
    { locale }: MailRenderContext,
  ) {
    const { headers, unsubscribeUrl } = this.unsubscribe(unsubscribe);
    const timeZone =
      timezone ?? this.config.get('APP_TIMEZONE', { infer: true });
    return {
      subject: this.i18n.t('mail.notificationDigest.subject', {
        locale,
        args: { count, app: this.app },
      }),
      template: 'notification-digest',
      headers,
      context: {
        name,
        unsubscribeUrl,
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
