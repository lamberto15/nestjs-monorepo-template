import { Module, type Provider } from '@nestjs/common';
import { WebhookManagementService } from './webhook-management.service.js';
import { RecordWebhooks } from './record-webhooks.service.js';
import { IncomingSendersService } from './incoming-senders.service.js';
import { IncomingEventHandlers } from './incoming-event-handlers.js';
import { TenantSenderGuard } from './tenant-sender.guard.js';
import { whenOn } from '../switches.js';
import { WebhookListSource } from './webhook-lists.js';
import { WebhookDeliveryRetentionJob } from './webhook-delivery-retention.job.js';
import { ListsModule } from '../lists/lists.module.js';
import { WebhookEndpointsController } from './webhook-endpoints.controller.js';
import { WebhookDeliveriesController } from './webhook-deliveries.controller.js';
import { WebhookEventTypesController } from './webhook-event-types.controller.js';
import { ClientWebhooksController } from './client-webhooks.controller.js';
import { IncomingSendersController } from './incoming-senders.controller.js';
import { IncomingEventTypesController } from './incoming-event-types.controller.js';
import { TenantWebhookReceiverController } from './tenant-webhook-receiver.controller.js';

/**
 * The webhooks capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [ListsModule],
  controllers: [
    // WEBHOOKS=off: no endpoint or delivery API (the module itself stays: the
    // notifications, approvals and incoming receivers inject it).
    ...whenOn(
      'WEBHOOKS',
      WebhookEndpointsController,
      WebhookDeliveriesController,
      WebhookEventTypesController,
      // An administrator managing a client's webhooks on its behalf.
      ClientWebhooksController,
    ),
    // Incoming webhooks of a tenant's own senders: not behind WEBHOOKS (that switch is for the outgoing ones).
    IncomingSendersController,
    IncomingEventTypesController,
    TenantWebhookReceiverController,
  ],
  providers: [
    // Both doors to a client's webhooks: its own routes and an administrator's.
    WebhookManagementService,
    // Who receives a record's webhook (its owner, the tenant-scope clients that may read it).
    RecordWebhooks,
    // A tenant's incoming webhook senders; features register the events they handle.
    IncomingSendersService,
    IncomingEventHandlers,
    TenantSenderGuard,
    // The delivery log's list (GET /v1/lists/WebhookDelivery), while WEBHOOKS is on.
    ...whenOn('WEBHOOKS', WebhookListSource),
    // Finished outgoing webhook deliveries older than WEBHOOKS_DELIVERY_RETENTION_DAYS, nightly.
    ...whenOn<Provider>('WEBHOOKS', WebhookDeliveryRetentionJob),
  ],
  exports: [
    WebhookManagementService,
    RecordWebhooks,
    IncomingSendersService,
    IncomingEventHandlers,
  ],
})
export class PlatformWebhooksModule {}
