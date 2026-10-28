import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import type { CoreEnv } from '../../core/config/core.env.js';

export interface ShareCode {
  code: string;
  /** Minutes the code works. */
  minutes: number;
}

/**
 * The code that opens a link shared with one address (SharesService): it
 * proves the mailbox, each time the link is opened. It names neither the
 * record nor who shared it: whoever holds the mailbox and the link already
 * knows, and a mail that went astray tells nothing.
 */
@Injectable()
export class ShareCodeMail implements Mailable<ShareCode> {
  constructor(
    private readonly i18n: I18nService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  render({ code, minutes }: ShareCode, { locale }: MailRenderContext) {
    const app = this.config.get('SERVICE_NAME', { infer: true });
    return {
      subject: this.i18n.t('mail.shareCode.subject', {
        locale,
        args: { app },
      }),
      template: 'share-code',
      context: { app, code, minutes },
    };
  }
}
