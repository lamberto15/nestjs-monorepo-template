import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import type { CoreEnv } from '../../core/config/core.env.js';

/** Who an account email goes to, and how they read it. */
export interface AccountMail {
  name: string;
  url: string;
  expiresAt: Date;
  /** The recipient's time zone (null: APP_TIMEZONE): the expiry is shown in it. */
  timezone: string | null;
}

/**
 * What the account emails share: the link, and its expiry in the
 * recipient's language and time zone. Mail is sent outside the recipient's
 * request, so the locale is always the one passed to `send()`.
 */
@Injectable() // Nest reads the subclasses' dependencies from here.
abstract class AccountMailable implements Mailable<AccountMail> {
  protected abstract readonly template:
    'reset-password' | 'invitation' | 'verify-email' | 'magic-link';
  protected abstract readonly subjectKey:
    | 'mail.resetPassword.subject'
    | 'mail.invitation.subject'
    | 'mail.verifyEmail.subject'
    | 'mail.magicLink.subject';

  constructor(
    protected readonly i18n: I18nService,
    protected readonly config: ConfigService<CoreEnv, true>,
  ) {}

  render(
    { name, url, expiresAt, timezone }: AccountMail,
    { locale }: MailRenderContext,
  ) {
    const env = this.config;
    const app = env.get('SERVICE_NAME', { infer: true });
    return {
      subject: this.i18n.t(this.subjectKey, { locale, args: { app } }),
      // <template>.de.html for German, else <template>.html
      template: this.template,
      context: {
        name,
        url,
        app,
        expiresAt: this.i18n.formatDate(expiresAt, {
          locale,
          // Intl refuses timeZoneName next to dateStyle/timeStyle: the fields instead.
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone ?? env.get('APP_TIMEZONE', { infer: true }),
          timeZoneName: 'short',
        }),
      },
    };
  }
}

@Injectable()
export class ResetPasswordMail extends AccountMailable {
  protected readonly template = 'reset-password';
  protected readonly subjectKey = 'mail.resetPassword.subject';
}

/** A password reset link for an account without a password: an invitation. */
@Injectable()
export class InvitationMail extends AccountMailable {
  protected readonly template = 'invitation';
  protected readonly subjectKey = 'mail.invitation.subject';
}

@Injectable()
export class VerifyEmailMail extends AccountMailable {
  protected readonly template = 'verify-email';
  protected readonly subjectKey = 'mail.verifyEmail.subject';
}

@Injectable()
export class MagicLinkMail extends AccountMailable {
  protected readonly template = 'magic-link';
  protected readonly subjectKey = 'mail.magicLink.subject';
}
