import { Module } from '@nestjs/common';
import {
  messagingClients,
  pushProvider,
  smsProvider,
} from './messaging.providers.js';
import { MessagingService } from './messaging.service.js';
import { MessagingLimits } from './messaging-limits.service.js';
import { MessagingProcessor } from './messaging.processor.js';
import { MessagingRetentionJob } from './messaging.retention.job.js';
import { MessagingMetrics } from './messaging.metrics.js';
import { SmsChannel } from './channels/sms.channel.js';
import { PushChannel } from './channels/push.channel.js';
import { SMS_PROVIDER } from './providers/sms-provider.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AccountModule } from '../account/account.module.js';
import { MessagingController } from './messaging.controller.js';
import { SmsInboundController } from './sms-inbound.controller.js';

/**
 * The messaging capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [
    PlatformKernelModule,
    SettingsModule,
    AccountModule,
    // Twilio and FCM (the messaging providers' HTTP calls).
    ...messagingClients(),
  ],
  controllers: [
    // Push devices and the SMS number; the provider's inbound STOP/START webhook.
    MessagingController,
    SmsInboundController,
  ],
  providers: [
    // Push and SMS (docs/notifications.md): channels that queue, a worker that sends within the caps.
    smsProvider,
    pushProvider,
    MessagingService,
    MessagingLimits,
    MessagingProcessor,
    MessagingRetentionJob,
    MessagingMetrics,
    SmsChannel,
    PushChannel,
  ],
  exports: [SMS_PROVIDER, MessagingService],
})
export class MessagingModule {}
