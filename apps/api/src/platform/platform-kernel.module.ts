import { Module, type Type } from '@nestjs/common';
import { switchedOn } from './switches.js';
import { Realtime } from './realtime/realtime.service.js';
import { NoRealtime } from './realtime/no-realtime.js';
import { RealtimeEmitter } from './realtime/realtime-emitter.js';
import { RecordActivity } from './realtime/record-activity.js';
import { DataTransferRegistry } from './data-transfer/data-transfer.registry.js';
import { DataTransferService } from './data-transfer/data-transfer.service.js';
import { DataTransferProcessor } from './data-transfer/data-transfer.processor.js';
import { NotificationChannelRegistry } from './notifications/notification-channel.registry.js';
import { NotificationCatalog } from './notifications/notification-catalog.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { NotificationUnsubscribeService } from './notifications/notification-unsubscribe.service.js';
import { notificationUnsubscribeLinksProvider } from './notifications/notification-unsubscribe.js';
import { IAM_NOTIFIER } from '../iam/iam-notifications.js';
import {
  NotificationMail,
  NotificationDigestMail,
} from './notifications/notification.mails.js';
import { NotificationDeliveryHandler } from './notifications/notification-delivery.handler.js';
import { RealtimeChannel } from './notifications/channels/realtime.channel.js';
import { EmailChannel } from './notifications/channels/email.channel.js';
import { WebhookChannel } from './notifications/channels/webhook.channel.js';
import { NotificationDigestJob } from './notifications/notification-digest.job.js';
import { NotificationRetentionJob } from './notifications/notification-retention.job.js';
import { NotificationTransfer } from './notifications/notification.transfer.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { SubscriptionsRegistry } from './subscriptions/subscriptions.registry.js';
import { ImportMappingsService } from './data-transfer/import-mappings.service.js';
import { PeopleModule } from './people/people.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { DataTransferController } from './data-transfer/data-transfer.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationUnsubscribeController } from './notifications/notification-unsubscribe.controller.js';
import { NotificationTestController } from './notifications/notification-test.controller.js';
import { SubscriptionsController } from './subscriptions/subscriptions.controller.js';
import { ImportMappingsController } from './data-transfer/import-mappings.controller.js';
import { inDevelopment } from './notifications/notification-test.js';

/**
 * The capabilities that need one another, in one module rather than modules
 * importing each other in a cycle (forwardRef): realtime (the socket gateway,
 * a record's activity), notifications and their channels, watching records
 * (subscriptions), and exports and imports (data-transfer). Imported by PlatformModule
 * (platform.module.ts).
 */
@Module({
  imports: [PeopleModule, QueuesModule, SettingsModule],
  controllers: [
    DataTransferController,
    NotificationsController,
    NotificationUnsubscribeController,
    // Development and tests only: POST /v1/notifications/test (production: 404, not in the OpenAPI document).
    ...inDevelopment<Type>(NotificationTestController),
    SubscriptionsController,
    ImportMappingsController,
  ],
  providers: [
    // socket.io gateway at /realtime; features inject it to push events.
    // REALTIME=off: the same token, pushes that do nothing, no gateway.
    switchedOn('REALTIME')
      ? Realtime
      : { provide: Realtime, useClass: NoRealtime },
    // Realtime's way to the API's sockets from a process without a socket server (the operator CLI).
    RealtimeEmitter,
    // A record's comments and attachments changed: its open pages hear of it.
    RecordActivity,
    // Exports and imports: features register their DataExporter / DataImporter.
    DataTransferRegistry,
    DataTransferService,
    DataTransferProcessor,
    // Notifications: features declare their types (options.notifications) and
    // call NotificationsService.notify(); the channels register themselves.
    NotificationChannelRegistry,
    NotificationCatalog,
    NotificationsService,
    NotificationUnsubscribeService,
    notificationUnsubscribeLinksProvider,
    // IAM's security notifications go through it (iam can't import the platform).
    { provide: IAM_NOTIFIER, useExisting: NotificationsService },
    NotificationMail,
    NotificationDigestMail,
    NotificationDeliveryHandler,
    RealtimeChannel,
    EmailChannel,
    WebhookChannel,
    NotificationDigestJob,
    NotificationRetentionJob,
    NotificationTransfer,
    // Watching records: features subscribe creators and notify the watchers of a change.
    SubscriptionsService,
    SubscriptionsRegistry,
    // Saved column mappings of an import (docs/data-transfer.md).
    ImportMappingsService,
  ],
  exports: [
    Realtime,
    RecordActivity,
    DataTransferRegistry,
    DataTransferService,
    NotificationChannelRegistry,
    NotificationCatalog,
    NotificationsService,
    NotificationUnsubscribeService,
    IAM_NOTIFIER,
    SubscriptionsService,
    SubscriptionsRegistry,
    ImportMappingsService,
  ],
})
export class PlatformKernelModule {}
