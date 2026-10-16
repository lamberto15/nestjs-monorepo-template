import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import { EssentialMail } from '../../core/mail/mail-suppression.js';

export interface AccountDeletionMailData {
  name: string;
  /** When the account will be deleted, unless cancelled. */
  scheduledFor: Date;
  /** The recipient's time zone (null: APP_TIMEZONE). */
  timezone: string | null;
}

/**
 * "Your account will be deleted on …, unless you cancel": sent when a user
 * asks for the deletion. A notice of a destructive action the person
 * asked for: essential, so it still goes to an address that complained.
 */
@EssentialMail()
@Injectable()
export class AccountDeletionMail implements Mailable<AccountDeletionMailData> {
  constructor(
    private readonly i18n: I18nService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  render(
    { name, scheduledFor, timezone }: AccountDeletionMailData,
    { locale }: MailRenderContext,
  ) {
    const app = this.config.get('SERVICE_NAME', { infer: true });
    const web = webUrl(this.config);
    return {
      subject: this.i18n.t('mail.accountDeletion.subject', {
        locale,
        args: { app },
      }),
      template: 'account-deletion',
      context: {
        name,
        app,
        url: web ? `${web}/account` : null,
        scheduledFor: this.i18n.formatDate(scheduledFor, {
          locale,
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone:
            timezone ?? this.config.get('APP_TIMEZONE', { infer: true }),
        }),
      },
    };
  }
}
