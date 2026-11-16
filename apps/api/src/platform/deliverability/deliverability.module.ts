import { Module } from '@nestjs/common';
import { MailSuppressionListSource } from './suppression.list-source.js';
import {
  MailEventIntakeRegistry,
  MailEventsService,
} from './mail-events.service.js';
import { MailEventsProcessor } from './mail-events.processor.js';
import { MailEventsRetentionJob } from './mail-events-retention.job.js';
import { SnsGateway, HttpSnsGateway, SNS_HTTP } from './sns/sns-gateway.js';
import { SesIntake } from './sns/ses-intake.js';
import { PostmarkIntake } from './postmark/postmark-intake.js';
import { ResendIntake } from './resend/resend-intake.js';
import { SendGridIntake } from './sendgrid/sendgrid-intake.js';
import { SuppressionsService } from './suppressions.service.js';
import { MAIL_SUPPRESSION } from '../../core/mail/mail-suppression.js';
import { MailDeliverySettings } from './mail-delivery.settings.js';
import { MAIL_DELIVERY } from '../../core/mail/mail-delivery.js';
import { MailSuppressionPolicy } from './suppression.policy.js';
import { HttpClientModule } from '@nestjs/http-client';
import { SettingsModule } from '../settings/settings.module.js';
import { AccountModule } from '../account/account.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { MailEventsController } from './mail-events.controller.js';
import { SuppressionsController } from './suppressions.controller.js';

/**
 * The deliverability capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [
    // SNS (the mail intake): signing certificates and subscription
    // confirmations, at URLs the intake has checked are SNS's own. No
    // base URL (the region is the message's); one short attempt, SNS retries.
    HttpClientModule.register({
      name: SNS_HTTP,
      timeout: '5s',
      retry: false,
      redirect: 'error',
    }),
    SettingsModule,
    AccountModule,
    ListsModule,
  ],
  controllers: [
    // Email deliverability: the providers' bounces and complaints, the suppression list.
    MailEventsController,
    SuppressionsController,
  ],
  providers: [
    // The suppression list (GET /v1/lists/MailSuppression), for the operators.
    MailSuppressionListSource,
    // Email deliverability (docs/deliverability.md): intakes register
    // themselves (SES through SNS); the queue applies their events to
    // the suppression list, which the core's mail queue asks through
    // MAIL_SUPPRESSION before every send.
    MailEventIntakeRegistry,
    MailEventsService,
    MailEventsProcessor,
    MailEventsRetentionJob,
    { provide: SnsGateway, useClass: HttpSnsGateway },
    SesIntake,
    PostmarkIntake,
    ResendIntake,
    SendGridIntake,
    SuppressionsService,
    { provide: MAIL_SUPPRESSION, useExisting: SuppressionsService },
    // Which mail leaves (mail.delivery), asked by the core's mail queue.
    MailDeliverySettings,
    { provide: MAIL_DELIVERY, useExisting: MailDeliverySettings },
    MailSuppressionPolicy,
  ],
  exports: [
    MailEventIntakeRegistry,
    MailEventsService,
    SuppressionsService,
    MAIL_SUPPRESSION,
    MAIL_DELIVERY,
  ],
})
export class DeliverabilityModule {}
