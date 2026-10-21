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
import { DrizzleIdempotencyStore } from './idempotency/drizzle-idempotency.store.js';
import { principalScope } from './idempotency/idempotency.scopes.js';
import { OpsController } from './ops/ops.controller.js';
import { FeaturesController } from './features/features.controller.js';
import { FeaturesService } from './features/features.service.js';
import { OpsPolicy } from './ops/ops.policy.js';
import { OpsQueues } from './ops/ops-queues.service.js';
import { OpsMetrics } from './ops/ops-metrics.js';
import type { PlatformEnv } from './platform.env.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from './platform.options.js';
import { IAM_NOTIFIER } from '../iam/iam-notifications.js';
import { ACTOR_NAMES } from '../iam/audit/actor-names.js';
import { AUTH_POLICY } from '../iam/auth/auth-policy.js';
import { AiController } from './ai/ai.controller.js';
import { AiProcessor } from './ai/ai.processor.js';
import { AiProvider, DisabledAiProvider } from './ai/ai-provider.js';
import { AiRegistry } from './ai/ai.registry.js';
import { AiService } from './ai/ai.service.js';
import { AI_SETTINGS } from './ai/ai-settings.js';
import { AnthropicProvider } from './ai/anthropic.provider.js';
import { AUTH_SETTINGS } from './auth-policy/auth-settings.js';
import { SettingsAuthPolicy } from './auth-policy/settings-auth-policy.js';
import { WebhookDeliveryRetentionJob } from './webhooks/webhook-delivery-retention.job.js';
import { WebhookDeliveriesController } from './webhooks/webhook-deliveries.controller.js';
import { WebhookEndpointsController } from './webhooks/webhook-endpoints.controller.js';
import { WebhookEventTypesController } from './webhooks/webhook-event-types.controller.js';
import { ClientWebhooksController } from './webhooks/client-webhooks.controller.js';
import { WebhookManagementService } from './webhooks/webhook-management.service.js';
import { IncomingEventHandlers } from './webhooks/incoming-event-handlers.js';
import { IncomingSendersController } from './webhooks/incoming-senders.controller.js';
import { IncomingSendersService } from './webhooks/incoming-senders.service.js';
import { TenantSenderGuard } from './webhooks/tenant-sender.guard.js';
import { TenantWebhookReceiverController } from './webhooks/tenant-webhook-receiver.controller.js';
import { WebhookListSource } from './webhooks/webhook-lists.js';
import { RecordingWebhookTransport } from './webhooks/recording.transport.js';
// Maps the webhooks package's errors to problem details.
import './webhooks/webhooks-error.filter.js';
import { webhooksOptions } from './webhooks/webhooks.config.js';
import { HttpClientModule } from '@nestjs/http-client';
import { MAIL_SUPPRESSION } from '../core/mail/mail-suppression.js';
import { MailEventsController } from './deliverability/mail-events.controller.js';
import { MailEventsProcessor } from './deliverability/mail-events.processor.js';
import { MailEventsRetentionJob } from './deliverability/mail-events-retention.job.js';
import {
  MailEventIntakeRegistry,
  MailEventsService,
} from './deliverability/mail-events.service.js';
import { SesIntake } from './deliverability/sns/ses-intake.js';
import { ResendIntake } from './deliverability/resend/resend-intake.js';
import { PostmarkIntake } from './deliverability/postmark/postmark-intake.js';
import { SendGridIntake } from './deliverability/sendgrid/sendgrid-intake.js';
import {
  HttpSnsGateway,
  SNS_HTTP,
  SnsGateway,
} from './deliverability/sns/sns-gateway.js';
import { MailSuppressionListSource } from './deliverability/suppression.list-source.js';
import { MailSuppressionPolicy } from './deliverability/suppression.policy.js';
import { SuppressionsController } from './deliverability/suppressions.controller.js';
import { SuppressionsService } from './deliverability/suppressions.service.js';
import { NoRealtime } from './realtime/no-realtime.js';
import { Realtime } from './realtime/realtime.service.js';
import { RecordActivity } from './realtime/record-activity.js';
import {
  PeopleController,
  TeamDirectoryController,
} from './people/people.controller.js';
import { PeopleService } from './people/people.service.js';
import { switchedOn, whenOn } from './switches.js';
import { FilesController } from './storage/files.controller.js';
import { storage } from './storage/storage.config.js';
import { platformQueues, queues } from './queues/queues.js';
import { DataTransferController } from './data-transfer/data-transfer.controller.js';
import { DataTransferProcessor } from './data-transfer/data-transfer.processor.js';
import { DataTransferRegistry } from './data-transfer/data-transfer.registry.js';
import { DataTransferService } from './data-transfer/data-transfer.service.js';
import { integrations } from './integrations/integrations.js';
import { BulkController } from './bulk/bulk.controller.js';
import { BulkProcessor } from './bulk/bulk.processor.js';
import { BulkRegistry } from './bulk/bulk.registry.js';
import { BulkService } from './bulk/bulk.service.js';
import { JobIndex } from './queues/job-index.js';
import { CustomFieldPolicy } from './custom-fields/custom-field.policy.js';
import { CustomFieldsController } from './custom-fields/custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields/custom-fields.service.js';
import { NotificationCatalog } from './notifications/notification-catalog.js';
import { NotificationChannelRegistry } from './notifications/notification-channel.registry.js';
import {
  NotificationDigestMail,
  NotificationMail,
} from './notifications/notification.mails.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationUnsubscribeController } from './notifications/notification-unsubscribe.controller.js';
import { NotificationUnsubscribeService } from './notifications/notification-unsubscribe.service.js';
import { notificationUnsubscribeLinksProvider } from './notifications/notification-unsubscribe.js';
import {
  inDevelopment,
  TEST_NOTIFICATIONS,
} from './notifications/notification-test.js';
import { NotificationTestController } from './notifications/notification-test.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { NotificationDeliveryHandler } from './notifications/notification-delivery.handler.js';
import { NotificationDigestJob } from './notifications/notification-digest.job.js';
import { NotificationRetentionJob } from './notifications/notification-retention.job.js';
import { NotificationTransfer } from './notifications/notification.transfer.js';
import { EmailChannel } from './notifications/channels/email.channel.js';
import { RealtimeChannel } from './notifications/channels/realtime.channel.js';
import { WebhookChannel } from './notifications/channels/webhook.channel.js';
import { SettingsController } from './settings/settings.controller.js';
import { SettingsService } from './settings/settings.service.js';
import {
  AccountController,
  AccountDeletionLinkController,
  ConsentKindsController,
} from './account/account.controller.js';
import { ConsentKinds } from './account/consent-kinds.js';
import { AccountDeletionJob } from './account/account-deletion.job.js';
import { AccountDeletionMail } from './account/account.mails.js';
import { AccountLifecycleService } from './account/account.service.js';
import { AvatarController } from './account/avatar.controller.js';
import { AvatarService } from './account/avatar.service.js';
import { deletionCancelLinksProvider } from './account/deletion-cancel-links.js';
import { AccountTransfer } from './account/account.transfer.js';
import { TenantCleanup } from './tenants/tenant-cleanup.js';
import { QuotaMetrics } from './quotas/quota.metrics.js';
import { QUOTA_SETTINGS } from './quotas/quota.settings.js';
import {
  OwnQuotasController,
  TenantQuotasController,
} from './quotas/quotas.controller.js';
import { QuotasService } from './quotas/quotas.service.js';
import { TenantExportController } from './tenants/tenant-export.controller.js';
import { TenantExports } from './tenants/tenant-exports.service.js';
import { TenantTransfer } from './tenants/tenant.transfer.js';
import { PersonalDataRegistry } from './account/personal-data.registry.js';
import { SubscriptionsController } from './subscriptions/subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { SubscriptionsRegistry } from './subscriptions/subscriptions.registry.js';
import { SearchController } from './search/search.controller.js';
import { SearchRegistry } from './search/search.registry.js';
import { SearchService } from './search/search.service.js';
import { ListsController } from './lists/lists.controller.js';
import { AccessListSources } from './lists/access-lists.js';
import { TenantListSource } from './lists/tenant-lists.js';
import { ListPolicy } from './lists/list.policy.js';
import { ListsRegistry } from './lists/lists.registry.js';
import { ListsService } from './lists/lists.service.js';
import { NamingSeriesController } from './sequences/naming-series.controller.js';
import { NamingSeriesRegistry } from './sequences/naming-series.registry.js';
import { NamingSeriesService } from './sequences/naming-series.service.js';
import { NamingVariables } from './sequences/naming-variables.js';
import { NUMBERING_SETTINGS } from './sequences/numbering-settings.js';
import { SequencesService } from './sequences/sequences.service.js';
import { AttachmentsController } from './attachments/attachments.controller.js';
import { AttachmentsRegistry } from './attachments/attachments.registry.js';
import { AttachmentsService } from './attachments/attachments.service.js';
import { AttachmentSweepJob } from './attachments/attachment-sweep.job.js';
import { COMMENT_NOTIFICATIONS } from './comments/comment-notifications.js';
import { CommentsRegistry } from './comments/comments.registry.js';
import { CommentsService } from './comments/comments.service.js';
import { TagsController } from './tags/tags.controller.js';
import { TagsRegistry } from './tags/tags.registry.js';
import { TagsService } from './tags/tags.service.js';
import { ViewsController } from './views/views.controller.js';
import { ViewsService } from './views/views.service.js';
import { ReportRunnerJob } from './reports/report-runner.job.js';
import { ReportFailedMail, ReportReadyMail } from './reports/report.mails.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { UsageController } from './usage/usage.controller.js';
import { UsageInterceptor } from './usage/usage.interceptor.js';
import { UsageRollupJob } from './usage/usage-rollup.job.js';
import { PlatformAnalyticsJob } from './analytics/platform-analytics.job.js';
import { UsageService } from './usage/usage.service.js';
import { RevisionRetentionJob } from './revisions/revision-retention.job.js';
import { RevisionsRegistry } from './revisions/revisions.registry.js';
import { RevisionsService } from './revisions/revisions.service.js';
import { ApprovalsController } from './approvals/approvals.controller.js';
import {
  ApprovalDelegationsController,
  ApprovalPoliciesController,
} from './approvals/approval-admin.controllers.js';
import { ApprovalDelegationsService } from './approvals/approval-delegations.service.js';
import { ApprovalEngine } from './approvals/approval-engine.service.js';
import { ModeGuard } from './mode/mode.guard.js';
import { ModeService } from './mode/mode.service.js';
import { MODE_SETTINGS } from './mode/mode.setting.js';
import { APPROVAL_NOTIFICATIONS } from './approvals/approval-events.js';
import { APPROVAL_SETTINGS } from './approvals/approval-settings.js';
import { ApprovalPoliciesService } from './approvals/approval-policies.service.js';
import { ApprovalAccessPolicy } from './approvals/approval.policy.js';
import { BUILT_IN_RULES } from './approvals/approval-rules.js';
import { ApprovalWorkflow } from './approvals/approval.workflow.js';
import { ApprovalsRegistry } from './approvals/approvals.registry.js';
import { ApprovalsService } from './approvals/approvals.service.js';
import { ApprovalMetrics } from './approvals/approval-metrics.js';
import { ReencryptionMetrics } from './encryption/reencryption.metrics.js';
import { MessagingController } from './messaging/messaging.controller.js';
import { SmsInboundController } from './messaging/sms-inbound.controller.js';
import { MessagingService } from './messaging/messaging.service.js';
import { MessagingLimits } from './messaging/messaging-limits.service.js';
import { MessagingProcessor } from './messaging/messaging.processor.js';
import { MessagingRetentionJob } from './messaging/messaging.retention.job.js';
import { MessagingMetrics } from './messaging/messaging.metrics.js';
import { pushProvider, smsProvider } from './messaging/messaging.providers.js';
import { MESSAGING_SETTINGS } from './messaging/messaging.settings.js';
import { SmsChannel } from './messaging/channels/sms.channel.js';
import { PushChannel } from './messaging/channels/push.channel.js';
import { ReencryptionProcessor } from './encryption/reencryption.processor.js';
import { RetentionController } from './retention/retention.controller.js';
import { RetentionProcessor } from './retention/retention.processor.js';
import { RetentionRegistry } from './retention/retention.registry.js';
import { RetentionScheduler } from './retention/retention.scheduler.js';
import { RetentionService } from './retention/retention.service.js';
import { ReencryptionScheduler } from './encryption/reencryption.scheduler.js';
import { ReencryptionService } from './encryption/reencryption.service.js';
import { DocumentTemplates } from './documents/document-templates.js';
import { DocumentsController } from './documents/documents.controller.js';
import { DocumentsProcessor } from './documents/documents.processor.js';
import { DocumentsRegistry } from './documents/documents.registry.js';
import { DocumentsService } from './documents/documents.service.js';
import { gotenbergClient, PdfRenderer } from './documents/pdf-renderer.js';
import { MoneyModule } from './money/money.module.js';

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
    return {
      module: PlatformModule,
      // Features inject Realtime and their queues (@InjectQueue) without importing it.
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
        ...queues(platformQueues(options.queues)),
        // Gotenberg, which renders the PDF documents (GOTENBERG_URL).
        gotenbergClient(),
        ...integrations(options.resiliencePresets ?? {}),
        // SNS (the mail intake): signing certificates and subscription
        // confirmations, at URLs the intake has checked are SNS's own. No
        // base URL (the region is the message's); one short attempt, SNS retries.
        HttpClientModule.register({
          name: SNS_HTTP,
          timeout: '5s',
          retry: false,
          redirect: 'error',
        }),
        WorkflowsModule.forRoot({
          worker: {
            // Workflow steps run where the role runs workers.
            enabled: runsWorkers(),
            concurrency: 10, // instances this process executes at once
            leaseDuration: '30s', // how long a crashed process keeps its instances
            shutdownTimeout: '10s', // how long a deploy waits for running steps
          },
        }),
        // Outgoing webhooks travel through the outbox: dispatched in the change's
        // transaction, handed to the webhooks worker after the commit.
        OutboxModule.forRootAsync({
          useFactory: () => ({
            relay: {
              enabled: process.env.OUTBOX_RELAY !== 'off' && runsWorkers(),
              pollInterval: '1s',
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
      ],
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
        TenantWebhookReceiverController,
        OpsController,
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
        SubscriptionsController,
        SearchController,
        ListsController,
        // The tenant's people and teams, for @mentions and pickers (GET /v1/people, GET /v1/teams).
        PeopleController,
        TeamDirectoryController,
        AttachmentsController,
        DocumentsController,
        AiController,
        TagsController,
        NamingSeriesController,
        ViewsController,
        RetentionController,
        ...whenOn('REPORTS', ReportsController),
        ...whenOn('USAGE', UsageController),
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
          provide: PLATFORM_OPTIONS,
          // The platform's own notification types first (comments' mentions, approvals).
          useValue: {
            ...options,
            notifications: [
              ...COMMENT_NOTIFICATIONS,
              ...APPROVAL_NOTIFICATIONS,
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
              ...AI_SETTINGS,
              ...(options.settings ?? []),
            ],
          },
        },
        OpsQueues,
        // Queue depths and the outbox on core's /metrics.
        OpsMetrics,
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
        // Both doors to a client's webhooks: its own routes and an administrator's.
        WebhookManagementService,
        // A tenant's incoming webhook senders; features register the events they handle.
        IncomingSendersService,
        IncomingEventHandlers,
        TenantSenderGuard,
        // Idempotency records in idempotency_keys; registers itself with IdempotencyStorage.
        DrizzleIdempotencyStore,
        OpsPolicy,
        // Which switches are on, for clients (GET /v1/features).
        FeaturesService,
        // platform.mode / APP_MODE: read-only and maintenance (docs/settings.md).
        ModeService,
        { provide: APP_GUARD, useClass: ModeGuard },
        // socket.io gateway at /realtime; features inject it to push events.
        // REALTIME=off: the same token, pushes that do nothing, no gateway.
        switchedOn('REALTIME')
          ? Realtime
          : { provide: Realtime, useClass: NoRealtime },
        // A record's comments and attachments changed: its open pages hear of it.
        RecordActivity,
        // The names behind principal keys, and the directory @mentions search.
        PeopleService,
        // Who queued which transfers and bulk runs (their lists).
        JobIndex,
        // Exports and imports: features register their DataExporter / DataImporter.
        DataTransferRegistry,
        DataTransferService,
        DataTransferProcessor,
        // Bulk operations: features register a BulkOperation and call BulkService.run().
        BulkRegistry,
        BulkService,
        BulkProcessor,
        // Custom fields: features declare their subjects (options.customFields) and inject the service.
        CustomFieldsService,
        CustomFieldPolicy,
        // Notifications: features declare their types (options.notifications) and
        // call NotificationsService.notify(); the channels register themselves.
        NotificationChannelRegistry,
        NotificationCatalog,
        NotificationsService,
        NotificationUnsubscribeService,
        notificationUnsubscribeLinksProvider,
        // IAM's security notifications go through it (iam can't import the platform).
        { provide: IAM_NOTIFIER, useExisting: NotificationsService },
        // The audit log's actor names (iam/audit, `actorName`): the people directory's.
        { provide: ACTOR_NAMES, useExisting: PeopleService },
        NotificationMail,
        NotificationDigestMail,
        NotificationDeliveryHandler,
        RealtimeChannel,
        EmailChannel,
        WebhookChannel,
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
        NotificationDigestJob,
        NotificationRetentionJob,
        NotificationTransfer,
        // Settings and flags: features declare them (options.settings) and read them through the service.
        SettingsService,
        // IAM's auth policies (iam can't import the platform): the tenants'
        // auth.* settings, which IAM reads under the env's ceiling.
        SettingsAuthPolicy,
        { provide: AUTH_POLICY, useExisting: SettingsAuthPolicy },
        // A person's own account: their data (features register PersonalDataSources), its deletion, consents.
        PersonalDataRegistry,
        AccountLifecycleService,
        AvatarService,
        ConsentKinds,
        deletionCancelLinksProvider,
        AccountTransfer,
        AccountDeletionJob,
        AccountDeletionMail,
        // A tenant's export (the operators'), and what its erase removes besides its rows.
        TenantTransfer,
        TenantExports,
        TenantCleanup,
        // Tenant limits: the deployment's defaults (settings), the views, the storage gauges.
        QuotasService,
        QuotaMetrics,
        // Watching records: features subscribe creators and notify the watchers of a change.
        SubscriptionsService,
        SubscriptionsRegistry,
        // Global search: features register a SearchSource.
        SearchRegistry,
        SearchService,
        // Lists described at runtime (GET /v1/lists/{subject}): features register their list.
        ListsRegistry,
        ListsService,
        ListPolicy,
        // The access API's users and audit lists (GET /v1/lists/User, /Audit).
        AccessListSources,
        // The delivery log's list (GET /v1/lists/WebhookDelivery), while WEBHOOKS is on.
        ...whenOn('WEBHOOKS', WebhookListSource),
        // The operators' tenants list (GET /v1/lists/Tenant).
        TenantListSource,
        // The suppression list (GET /v1/lists/MailSuppression), for the operators.
        MailSuppressionListSource,
        // Gapless human-readable numbers, taken in a write's transaction.
        SequencesService,
        // Naming series: numbered features register and take numbers through it.
        NamingSeriesRegistry,
        NamingVariables,
        NamingSeriesService,
        // Files attached to records: features register an AttachmentTarget.
        AttachmentsRegistry,
        AttachmentsService,
        AttachmentSweepJob,
        // PDF documents of records: features register a DocumentSource and call DocumentsService.request().
        DocumentsRegistry,
        DocumentTemplates,
        PdfRenderer,
        DocumentsService,
        DocumentsProcessor,
        // The AI helper: features register an AiSource; Anthropic unless another AiProvider is provided.
        AiRegistry,
        {
          provide: AiProvider,
          inject: [ConfigService],
          useFactory: (config: ConfigService<PlatformEnv, true>) => {
            const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
            return apiKey
              ? new AnthropicProvider({
                  apiKey,
                  baseURL: config.get('AI_BASE_URL', { infer: true }),
                })
              : new DisabledAiProvider();
          },
        },
        AiService,
        AiProcessor,
        // Comments and mentions: features register a CommentTarget and call CommentsService.
        CommentsRegistry,
        CommentsService,
        // Tags: features register a TagTarget and call TagsService.
        TagsRegistry,
        TagsService,
        // Saved views: a list's filters, sort and columns under a name (private, team, tenant).
        ViewsService,
        // Scheduled reports: exports run on a schedule, mailed to their recipients.
        ...whenOn<Provider>(
          'REPORTS',
          ReportsService,
          ReportRunnerJob,
          ReportReadyMail,
          ReportFailedMail,
        ),
        // API clients' usage: counted per day and route, daily quotas, the nightly roll-up.
        // USAGE=off: no metering, no quota enforcement, no roll-up.
        ...whenOn<Provider>('USAGE', UsageService, UsageRollupJob, {
          provide: APP_INTERCEPTOR,
          useClass: UsageInterceptor,
        }),
        // Platform analytics: anonymized aggregates across tenants, for the reporting role, nightly.
        PlatformAnalyticsJob,
        // Finished outgoing webhook deliveries older than WEBHOOKS_DELIVERY_RETENTION_DAYS, nightly.
        ...whenOn<Provider>('WEBHOOKS', WebhookDeliveryRetentionJob),
        // Record revisions: features register a RevisionTarget and call RevisionsService.record().
        RevisionsRegistry,
        RevisionsService,
        RevisionRetentionJob,
        // Approvals: features declare actions (options.approvals) and register their
        // handlers, rules, modes, conditions and listeners into ApprovalsRegistry.
        ApprovalsRegistry,
        ...BUILT_IN_RULES,
        ApprovalPoliciesService,
        ApprovalEngine,
        ApprovalWorkflow,
        ApprovalsService,
        ApprovalDelegationsService,
        ApprovalAccessPolicy,
        // Open and overdue requests on /metrics.
        ApprovalMetrics,
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
        MailSuppressionPolicy,
        // Encrypted columns onto the current keys (docs/encryption.md):
        // hourly scheduling, one batch per queue job, the stale rows on /metrics.
        ReencryptionService,
        ReencryptionProcessor,
        ReencryptionScheduler,
        ReencryptionMetrics,
        // Retention rules features declare, run nightly on a queue (docs/retention.md).
        RetentionRegistry,
        RetentionService,
        RetentionProcessor,
        RetentionScheduler,
      ],
      exports: [
        Realtime,
        RecordActivity,
        PeopleService,
        BullModule,
        DataTransferRegistry,
        BulkRegistry,
        BulkService,
        CustomFieldsService,
        NotificationsService,
        IAM_NOTIFIER,
        ACTOR_NAMES,
        AUTH_POLICY,
        NotificationChannelRegistry,
        SettingsService,
        PersonalDataRegistry,
        SubscriptionsService,
        SubscriptionsRegistry,
        SearchRegistry,
        ListsRegistry,
        SequencesService,
        NamingSeriesService,
        AttachmentsRegistry,
        AttachmentsService,
        DocumentsRegistry,
        DocumentsService,
        AiRegistry,
        CommentsRegistry,
        CommentsService,
        TagsRegistry,
        TagsService,
        RetentionRegistry,
        RevisionsRegistry,
        RevisionsService,
        ApprovalsRegistry,
        ApprovalsService,
        // ExchangeRatesService, to the features.
        MoneyModule,
        MAIL_SUPPRESSION,
        MailEventIntakeRegistry,
        IncomingEventHandlers,
      ],
    };
  }
}
