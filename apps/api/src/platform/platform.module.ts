import { randomBytes } from 'node:crypto';
import {
  type DynamicModule,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { getDrizzleToken } from '@nestjs/drizzle';
import { ConfigService } from '@nestjs/config';
import { IdempotencyModule } from '@nestjs/idempotency';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { WebhooksModule, WebhooksStorage } from '@nestjs/webhooks';
import { PostgresWebhookStore } from '@nestjs/webhooks/postgres';
import { WorkflowsModule, WorkflowStorage } from '@nestjs/workflows';
import { fromDrizzle, PostgresWorkflowStore } from '@nestjs/workflows/postgres';
import { runsWorkers } from '../core/config/core.env.js';
import { loadOrCreateSecret, type Database } from '../core/database/drizzle.js';
import { principalScope } from './idempotency/idempotency.scopes.js';
import { OpsController } from './ops/ops.controller.js';
import { FeaturesController } from './features/features.controller.js';
import { ConfigBundlesController } from './config-bundles/config-bundles.controller.js';
import type { PlatformEnv } from './platform.env.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from './platform.options.js';
import { AiController } from './ai/ai.controller.js';
import { AI_SETTINGS } from './ai/ai-settings.js';
import { FORM_SETTINGS } from './forms/form-settings.js';
import { FormsController } from './forms/forms.controller.js';
import {
  FormPublicLinksController,
  PublicFormsController,
} from './forms/form-public-links.controller.js';
import { FormSubmissionsController } from './forms/form-submissions.controller.js';
import { AUTH_SETTINGS } from './auth-policy/auth-settings.js';
import { DASHBOARD_SETTINGS } from './settings/dashboard.setting.js';
import { WebhookDeliveriesController } from './webhooks/webhook-deliveries.controller.js';
import { WebhookEndpointsController } from './webhooks/webhook-endpoints.controller.js';
import { WebhookEventTypesController } from './webhooks/webhook-event-types.controller.js';
import { ClientWebhooksController } from './webhooks/client-webhooks.controller.js';
import { IncomingSendersController } from './webhooks/incoming-senders.controller.js';
import { IncomingEventTypesController } from './webhooks/incoming-event-types.controller.js';
import { TenantWebhookReceiverController } from './webhooks/tenant-webhook-receiver.controller.js';
import { RecordingWebhookTransport } from './webhooks/recording.transport.js';
// Maps the webhooks package's errors to problem details.
import './webhooks/webhooks-error.filter.js';
import { webhooksOptions } from './webhooks/webhooks.config.js';
import { ClientErrorsController } from './client-errors/client-errors.controller.js';
import { MailEventsController } from './deliverability/mail-events.controller.js';
import { SuppressionsController } from './deliverability/suppressions.controller.js';
import {
  PeopleController,
  UnitDirectoryController,
} from './people/people.controller.js';
import { whenOn } from './switches.js';
import { FilesController } from './storage/files.controller.js';
import { storage } from './storage/storage.config.js';
import { platformQueues, queues } from './queues/queues.js';
import { DataTransferController } from './data-transfer/data-transfer.controller.js';
import { DATA_TRANSFER_SETTINGS } from './data-transfer/data-transfer.settings.js';
import { integrations } from './integrations/integrations.js';
import { BulkController } from './bulk/bulk.controller.js';
import { CustomFieldsController } from './custom-fields/custom-fields.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationUnsubscribeController } from './notifications/notification-unsubscribe.controller.js';
import {
  inDevelopment,
  TEST_NOTIFICATIONS,
} from './notifications/notification-test.js';
import { NotificationTestController } from './notifications/notification-test.controller.js';
import { SettingsController } from './settings/settings.controller.js';
import {
  AccountController,
  AccountDeletionLinkController,
  ConsentKindsController,
} from './account/account.controller.js';
import { AvatarController } from './account/avatar.controller.js';
import {
  BrandingController,
  PublicBrandingController,
} from './branding/branding.controller.js';
import {
  BrandingDomainsController,
  DomainAskController,
  HostBrandingController,
} from './branding/branding-domains.controller.js';
import { BRANDING_SETTINGS } from './branding/branding.settings.js';
import { DELIVERABILITY_SETTINGS } from './deliverability/mail-delivery.settings.js';
import { QUOTA_SETTINGS } from './quotas/quota.settings.js';
import {
  OwnQuotasController,
  TenantQuotasController,
} from './quotas/quotas.controller.js';
import { TenantExportController } from './tenants/tenant-export.controller.js';
import { SubscriptionsController } from './subscriptions/subscriptions.controller.js';
import { SearchController } from './search/search.controller.js';
import { ListsController } from './lists/lists.controller.js';
import { NamingSeriesController } from './sequences/naming-series.controller.js';
import { NUMBERING_SETTINGS } from './sequences/numbering-settings.js';
import {
  AttachmentAcknowledgmentsController,
  MyAcknowledgmentsController,
} from './acknowledgments/acknowledgments.controller.js';
import { ACKNOWLEDGMENT_NOTIFICATIONS } from './acknowledgments/acknowledgment-notifications.js';
import { ATTACHMENT_NOTIFICATIONS } from './attachments/attachment-scan.queue.js';
import { AttachmentsController } from './attachments/attachments.controller.js';
import { COMMENT_NOTIFICATIONS } from './comments/comment-notifications.js';
import { TagsController } from './tags/tags.controller.js';
import { ImportMappingsController } from './data-transfer/import-mappings.controller.js';
import { FavoritesController } from './favorites/favorites.controller.js';
import { InboxController } from './inbox/inbox.controller.js';
import { PresenceController } from './presence/presence.controller.js';
import { RecentsController } from './recents/recents.controller.js';
import { SharedController } from './shares/shared.controller.js';
import { AUTOMATION_NOTIFICATIONS } from './automations/automation-events.js';
import { AutomationsController } from './automations/automations.controller.js';
import { DataQualityController } from './data-quality/data-quality.controller.js';
import { ChoicesController } from './choices/choices.controller.js';
import { TemplatesController } from './templates/templates.controller.js';
import { ViewsController } from './views/views.controller.js';
import { CalendarsController } from './calendars/calendars.controller.js';
import { RecordSchedulesController } from './recurrence/record-schedules.controller.js';
import { ReportsController } from './reports/reports.controller.js';
import { UsageController } from './usage/usage.controller.js';
import { UsageInterceptor } from './usage/usage.interceptor.js';
import { ApprovalsController } from './approvals/approvals.controller.js';
import {
  ApprovalDelegationsController,
  ApprovalPoliciesController,
} from './approvals/approval-admin.controllers.js';
import { ModeGuard } from './mode/mode.guard.js';
import { MODE_SETTINGS } from './mode/mode.setting.js';
import { APPROVAL_NOTIFICATIONS } from './approvals/approval-events.js';
import { APPROVAL_SETTINGS } from './approvals/approval-settings.js';
import { MessagingController } from './messaging/messaging.controller.js';
import { SmsInboundController } from './messaging/sms-inbound.controller.js';
import { MESSAGING_SETTINGS } from './messaging/messaging.settings.js';
import { RetentionController } from './retention/retention.controller.js';
import { DocumentsController } from './documents/documents.controller.js';
import { MoneyModule } from './money/money.module.js';

import { PlatformOpsModule } from './ops/ops.module.js';
import { ConfigBundlesModule } from './config-bundles/config-bundles.module.js';
import { PlatformWebhooksModule } from './webhooks/webhooks.module.js';
import { PlatformIdempotencyModule } from './idempotency/idempotency.module.js';
import { PlatformFeaturesModule } from './features/features.module.js';
import { ModeModule } from './mode/mode.module.js';
import { PlatformKernelModule } from './platform-kernel.module.js';
import { PeopleModule } from './people/people.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { BulkModule } from './bulk/bulk.module.js';
import { CustomFieldsModule } from './custom-fields/custom-fields.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { AuthPolicyModule } from './auth-policy/auth-policy.module.js';
import { AccountModule } from './account/account.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { QuotasModule } from './quotas/quotas.module.js';
import { SearchModule } from './search/search.module.js';
import { ListsModule } from './lists/lists.module.js';
import { DeliverabilityModule } from './deliverability/deliverability.module.js';
import { SequencesModule } from './sequences/sequences.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { ImagesModule } from './images/images.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { PlatformAiModule } from './ai/ai.module.js';
import { CommentsModule } from './comments/comments.module.js';
import { AcknowledgmentsModule } from './acknowledgments/acknowledgments.module.js';
import { TagsModule } from './tags/tags.module.js';
import { ViewsModule } from './views/views.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { ChoicesModule } from './choices/choices.module.js';
import { FavoritesModule } from './favorites/favorites.module.js';
import { RecentsModule } from './recents/recents.module.js';
import { PresenceModule } from './presence/presence.module.js';
import { InboxModule } from './inbox/inbox.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { FormsModule } from './forms/forms.module.js';
import { CalendarsModule } from './calendars/calendars.module.js';
import { RecurrenceModule } from './recurrence/recurrence.module.js';
import { SharesModule } from './shares/shares.module.js';
import { DataQualityModule } from './data-quality/data-quality.module.js';
import { AutomationsModule } from './automations/automations.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { UsageModule } from './usage/usage.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { RevisionsModule } from './revisions/revisions.module.js';
import { ClientErrorsModule } from './client-errors/client-errors.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { EncryptionModule } from './encryption/encryption.module.js';
import { RetentionModule } from './retention/retention.module.js';
/**
 * The outbox, workflow and webhook stores only check their schemas at
 * startup, never create or upgrade them: the app connects as a role that
 * may not change the schema (docs/deployment.md, "Database roles"). Their
 * migrations run as the owner, through their CLIs, in `node dist/migrate`
 * and in the app's startup migration (MIGRATE_ON_START, development).
 */
const migrate = false;

/** The platform's secrets: from the environment, or created once and kept in the database. */
const PLATFORM_SECRETS = Symbol('PLATFORM_SECRETS');
interface PlatformSecrets {
  /** Seal stored idempotent responses (AES-256-GCM), newest first. */
  idempotency: string[];
  /** Each incoming sender's shared secret, by name. */
  senders: Record<string, string>;
}

/**
 * Reliable work around your features: Idempotency-Key on writes, the
 * transactional outbox, outgoing webhooks for API clients (and verified
 * incoming ones), durable workflows, and the operations API.
 *
 * Features declare their event types and incoming senders and hand them over
 * here, so the platform never imports them:
 *
 * ```ts
 * PlatformModule.forRoot({ eventTypes: [...NOTE_EVENT_TYPES], incomingWebhooks: [EXAMPLE_SENDER], customFields: [NOTE_CUSTOM_FIELDS], notifications: [...NOTE_NOTIFICATIONS] })
 * ```
 *
 * The packages' modules are global: features inject WorkflowClient,
 * Webhooks, Outbox and use @Idempotent(), @Workflow(), @VerifyWebhook().
 *
 * The composition root of the platform (docs/architecture.md, "The
 * platform's modules"): the packages' modules, then one module per
 * capability folder (`<folder>/<folder>.module.ts`, importing the ones it
 * injects from; platform-kernel.module.ts for those that need one another),
 * re-exported for the features, IAM and core. The options and the queues
 * come from one global module (optionsModule below). The routes and the
 * platform's global enhancers stay here: see `controllers` and `providers`.
 */
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    const secrets = {
      provide: PLATFORM_SECRETS,
      inject: [getDrizzleToken()],
      useFactory: async (db: Database): Promise<PlatformSecrets> => {
        const senders: Record<string, string> = {};
        for (const sender of options.incomingWebhooks ?? []) {
          senders[sender.name] = await loadOrCreateSecret(
            db,
            sender.secretEnv,
            () => `whsec_${randomBytes(32).toString('base64')}`,
          );
        }
        const idempotency = await loadOrCreateSecret(
          db,
          'IDEMPOTENCY_KEYS',
          () => randomBytes(32).toString('base64'),
        );
        return {
          idempotency: idempotency.split(',').map((key) => key.trim()),
          senders,
        };
      },
    };
    // The packages' async factories run in their own modules: this one gives them the secrets.
    const secretsModule: DynamicModule = {
      module: class PlatformSecretsModule {},
      providers: [secrets],
      exports: [PLATFORM_SECRETS],
    };
    // The options, and the queues the platform and the features name: what every
    // capability module reads, from the one global module of the platform's own.
    const optionsModule: DynamicModule = {
      module: class PlatformOptionsModule {},
      global: true,
      imports: [...queues(platformQueues(options.queues))],
      providers: [
        {
          provide: PLATFORM_OPTIONS,
          // The platform's own notification types first (comments' mentions, approvals).
          useValue: {
            ...options,
            notifications: [
              ...COMMENT_NOTIFICATIONS,
              ...ACKNOWLEDGMENT_NOTIFICATIONS,
              ...APPROVAL_NOTIFICATIONS,
              ...AUTOMATION_NOTIFICATIONS,
              ...ATTACHMENT_NOTIFICATIONS,
              // Development only, with the route that sends it.
              ...inDevelopment(...TEST_NOTIFICATIONS),
              ...(options.notifications ?? []),
            ],
            // And its own settings (IAM's auth policies, numbering's, approvals' delegation limit).
            settings: [
              ...AUTH_SETTINGS,
              ...MODE_SETTINGS,
              ...NUMBERING_SETTINGS,
              ...APPROVAL_SETTINGS,
              ...MESSAGING_SETTINGS,
              ...QUOTA_SETTINGS,
              ...BRANDING_SETTINGS,
              ...DELIVERABILITY_SETTINGS,
              ...DASHBOARD_SETTINGS,
              ...AI_SETTINGS,
              ...FORM_SETTINGS,
              ...DATA_TRANSFER_SETTINGS,
              ...(options.settings ?? []),
            ],
          },
        },
      ],
      exports: [PLATFORM_OPTIONS, BullModule],
    };
    return {
      module: PlatformModule,
      // Features inject Realtime and the rest the capability modules export (re-exported below) without importing it.
      global: true,
      imports: [
        // Idempotency-Key on the routes marked @Idempotent(): a retry gets the
        // first response instead of running the handler again. Its interceptor
        // is global, outermost but for UsageInterceptor (this module's own
        // providers register before its imports'): a 403 is stored and
        // replayed like any other 4xx, a client past its quota gets the 429
        // before any replay, and a replay is metered. Guards run before every interceptor, so the scope sees the caller.
        IdempotencyModule.forRootAsync({
          imports: [secretsModule],
          inject: [PLATFORM_SECRETS, ConfigService],
          useFactory: (
            platform: PlatformSecrets,
            config: ConfigService<PlatformEnv, true>,
          ) => ({
            // IDEMPOTENCY=required|optional: the default of every @Idempotent()
            // route, which can still say otherwise for itself.
            required: config.get('IDEMPOTENCY', { infer: true }) === 'required',
            scope: principalScope,
            ttl: '24h', // longer than any client keeps retrying
            lockTtl: '60s', // how long a crashed instance blocks a key
            retryAfter: '1s',
            // Stored responses can hold an endpoint's secret: seal them at rest.
            encryption: { keys: platform.idempotency },
          }),
        }),
        // After IdempotencyModule, whose interceptor must come first.
        // Private file storage (local or S3) behind signed URLs.
        storage(),
        // The options and the queues, for every module below (global).
        optionsModule,
        ...integrations(),
        WorkflowsModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<PlatformEnv, true>) => ({
            worker: {
              // Workflow steps run where the role runs workers (WORKFLOWS_WORKER=off: not here).
              enabled: process.env.WORKFLOWS_WORKER !== 'off' && runsWorkers(),
              // Instances this process executes at once (WORKFLOW_CONCURRENCY).
              concurrency: config.get('WORKFLOW_CONCURRENCY', { infer: true }),
              leaseDuration: '30s', // how long a crashed process keeps its instances
              shutdownTimeout: '10s', // how long a deploy waits for running steps
            },
          }),
        }),
        // Outgoing webhooks travel through the outbox: dispatched in the change's
        // transaction, handed to the webhooks worker after the commit.
        OutboxModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<PlatformEnv, true>) => ({
            relay: {
              enabled: process.env.OUTBOX_RELAY !== 'off' && runsWorkers(),
              pollInterval: '1s',
              // Events claimed per poll, and dispatched at once.
              batchSize: config.get('OUTBOX_RELAY_BATCH_SIZE', { infer: true }),
              concurrency: config.get('OUTBOX_RELAY_CONCURRENCY', {
                infer: true,
              }),
            },
          }),
        }),
        WebhooksModule.forRootAsync({
          // The package's HTTP transport, recording each request's headers for the delivery log.
          transport: RecordingWebhookTransport,
          imports: [secretsModule],
          inject: [PLATFORM_SECRETS],
          useFactory: (platform: PlatformSecrets) =>
            webhooksOptions(options, platform.senders),
        }),
        // Money: exchange rates (the ECB's), conversion, /v1/money.
        MoneyModule,
        // The capability modules, one per folder (platform-kernel.module.ts: the
        // ones that need one another). Last: they register no global enhancer.
        PlatformOpsModule,
        ConfigBundlesModule,
        PlatformWebhooksModule,
        PlatformIdempotencyModule,
        PlatformFeaturesModule,
        ModeModule,
        PlatformKernelModule,
        PeopleModule,
        QueuesModule,
        BulkModule,
        CustomFieldsModule,
        MessagingModule,
        SettingsModule,
        AuthPolicyModule,
        AccountModule,
        TenantsModule,
        QuotasModule,
        SearchModule,
        ListsModule,
        DeliverabilityModule,
        SequencesModule,
        AttachmentsModule,
        ImagesModule,
        DocumentsModule,
        PlatformAiModule,
        CommentsModule,
        AcknowledgmentsModule,
        TagsModule,
        ViewsModule,
        TemplatesModule,
        ChoicesModule,
        FavoritesModule,
        RecentsModule,
        PresenceModule,
        InboxModule,
        ApprovalsModule,
        FormsModule,
        CalendarsModule,
        RecurrenceModule,
        SharesModule,
        DataQualityModule,
        AutomationsModule,
        ReportsModule,
        UsageModule,
        AnalyticsModule,
        RevisionsModule,
        ClientErrorsModule,
        BrandingModule,
        EncryptionModule,
        RetentionModule,
      ],
      // Every route of the platform, here rather than in its capability's module:
      // the OpenAPI document lists the routes module by module, so this list's
      // order is the order of its paths (and of packages/api-client's types).
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
        OpsController,
        ConfigBundlesController,
        FeaturesController,
        FilesController,
        DataTransferController,
        BulkController,
        CustomFieldsController,
        NotificationsController,
        NotificationUnsubscribeController,
        // Push devices and the SMS number; the provider's inbound STOP/START webhook.
        MessagingController,
        SmsInboundController,
        // Development and tests only: POST /v1/notifications/test (production: 404, not in the OpenAPI document).
        ...inDevelopment<Type>(NotificationTestController),
        SettingsController,
        AccountController,
        // The user's picture (PUT, DELETE /v1/account/avatar).
        AvatarController,
        AccountDeletionLinkController,
        ConsentKindsController,
        // The operators' export of a tenant (POST /v1/tenants/{id}/export).
        TenantExportController,
        // Tenants' use and limits (GET /v1/tenants/{id}/usage, PUT …/quotas, GET /v1/tenant/usage).
        TenantQuotasController,
        OwnQuotasController,
        // The tenant's colour, mail sender name and logo (docs/branding.md).
        BrandingController,
        PublicBrandingController,
        // Its custom domains, the brand before sign-in by host, the edge's TLS ask.
        BrandingDomainsController,
        HostBrandingController,
        DomainAskController,
        SubscriptionsController,
        SearchController,
        ListsController,
        // The tenant's people and units, for @mentions and pickers (GET /v1/people, GET /v1/organizational-units).
        PeopleController,
        UnitDirectoryController,
        AttachmentsController,
        AttachmentAcknowledgmentsController,
        MyAcknowledgmentsController,
        DocumentsController,
        AiController,
        TagsController,
        NamingSeriesController,
        CalendarsController,
        RecordSchedulesController,
        ViewsController,
        TemplatesController,
        ChoicesController,
        FavoritesController,
        RecentsController,
        PresenceController,
        InboxController,
        // Runtime forms (docs/forms.md): off per tenant until `forms.enabled`.
        FormsController,
        FormSubmissionsController,
        FormPublicLinksController,
        // Filling in a public form without a sign-in (POST /v1/public/forms/open, /submit).
        PublicFormsController,
        // Opening a record's read-only link, without a sign-in (POST /v1/shared/open).
        SharedController,
        // Tenant automation rules (docs/automations.md).
        AutomationsController,
        DataQualityController,
        ImportMappingsController,
        RetentionController,
        ...whenOn('REPORTS', ReportsController),
        ...whenOn('USAGE', UsageController),
        // The web app's own unexpected errors (apps/web/src/lib/report-error.ts).
        ClientErrorsController,
        // Email deliverability: the providers' bounces and complaints, the suppression list.
        MailEventsController,
        SuppressionsController,
        // Before ApprovalsController: its /approvals/{id} would read `delegations` as an id.
        ApprovalDelegationsController,
        ApprovalPoliciesController,
        ApprovalsController,
      ],
      providers: [
        {
          // Instances and journals in your database, in a schema of their own (nest_workflows)
          provide: PostgresWorkflowStore,
          inject: [getDrizzleToken(), WorkflowStorage],
          useFactory: (db: Database, workflowStorage: WorkflowStorage) =>
            new PostgresWorkflowStore(
              { executor: fromDrizzle(db), migrate },
              workflowStorage,
            ),
        },
        {
          // Outbox messages and the inbox, in your database, in a schema of their own (nest_outbox)
          provide: PostgresOutboxStore,
          inject: [getDrizzleToken(), OutboxStorage],
          useFactory: (db: Database, outboxStorage: OutboxStorage) =>
            new PostgresOutboxStore(
              { executor: fromDrizzle(db), migrate },
              outboxStorage,
            ),
        },
        {
          // Endpoints, deliveries and their log, in your database, in a schema of their own (nest_webhooks)
          provide: PostgresWebhookStore,
          inject: [getDrizzleToken(), WebhooksStorage],
          useFactory: (db: Database, webhooksStorage: WebhooksStorage) =>
            new PostgresWebhookStore(
              { executor: fromDrizzle(db), migrate },
              webhooksStorage,
            ),
        },
        // platform.mode / APP_MODE: read-only and maintenance (docs/settings.md);
        // ModeService is ModeModule's. A global guard: here, in this module's order.
        { provide: APP_GUARD, useClass: ModeGuard },
        // USAGE=on: the metering interceptor (UsageService: UsageModule's), here among the
        // platform's global enhancers, whose order is this module's (app.module.ts).
        ...whenOn<Provider>('USAGE', {
          provide: APP_INTERCEPTOR,
          useClass: UsageInterceptor,
        }),
      ],
      exports: [
        PlatformKernelModule,
        PeopleModule,
        BulkModule,
        CustomFieldsModule,
        AuthPolicyModule,
        SettingsModule,
        AccountModule,
        DataQualityModule,
        SharesModule,
        AutomationsModule,
        SearchModule,
        ListsModule,
        SequencesModule,
        AttachmentsModule,
        AcknowledgmentsModule,
        // A record's templates register here (record-parts.ts).
        TemplatesModule,
        DocumentsModule,
        PlatformAiModule,
        CommentsModule,
        TagsModule,
        RetentionModule,
        RevisionsModule,
        ApprovalsModule,
        // ExchangeRatesService, to the features.
        MoneyModule,
        DeliverabilityModule,
        BrandingModule,
        PlatformWebhooksModule,
      ],
    };
  }
}
