import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import type { CoreEnv } from '../../core/config/core.env.js';

/** A report's file is ready. */
export interface ReportReadyMailData {
  report: string;
  /** The signed download link. */
  url: string;
  expiresAt: Date;
  rows: number;
  /** The report's time zone: the expiry is shown in it. */
  timezone: string;
}

/** A report's export failed. */
export interface ReportFailedMailData {
  report: string;
}

/** "Your report is ready: download it until …", in the owner's language. */
@Injectable()
export class ReportReadyMail implements Mailable<ReportReadyMailData> {
  constructor(
    private readonly i18n: I18nService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  render(
    { report, url, expiresAt, rows, timezone }: ReportReadyMailData,
    { locale }: MailRenderContext,
  ) {
    const app = this.config.get('SERVICE_NAME', { infer: true });
    return {
      subject: this.i18n.t('mail.reportReady.subject', {
        locale,
        args: { report, app },
      }),
      template: 'report-ready',
      context: {
        report,
        url,
        rows,
        app,
        expiresAt: this.i18n.formatDate(expiresAt, {
          locale,
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
          timeZoneName: 'short',
        }),
      },
    };
  }
}

/** "Your report could not be made this time." */
@Injectable()
export class ReportFailedMail implements Mailable<ReportFailedMailData> {
  constructor(
    private readonly i18n: I18nService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  render({ report }: ReportFailedMailData, { locale }: MailRenderContext) {
    const app = this.config.get('SERVICE_NAME', { infer: true });
    return {
      subject: this.i18n.t('mail.reportFailed.subject', {
        locale,
        args: { report, app },
      }),
      template: 'report-failed',
      context: { report, app },
    };
  }
}
