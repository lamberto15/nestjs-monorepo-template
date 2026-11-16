import { Module } from '@nestjs/common';
import { smsProvider, pushProvider } from './messaging.providers.js';
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

/**
 * The messaging capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, SettingsModule, AccountModule],
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
