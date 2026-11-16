import { randomBytes } from 'node:crypto';
import { type DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
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
import type { PlatformEnv } from './platform.env.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from './platform.options.js';
import { AI_SETTINGS } from './ai/ai-settings.js';
import { FORM_SETTINGS } from './forms/form-settings.js';
import { AUTH_SETTINGS } from './auth-policy/auth-settings.js';
import { DASHBOARD_SETTINGS } from './settings/dashboard.setting.js';
import { RecordingWebhookTransport } from './webhooks/recording.transport.js';
// Maps the webhooks package's errors to problem details.
import './webhooks/webhooks-error.filter.js';
import { webhooksOptions } from './webhooks/webhooks.config.js';
import { storage } from './storage/storage.config.js';
import { platformQueues, queues } from './queues/queues.js';
import { DATA_TRANSFER_SETTINGS } from './data-transfer/data-transfer.settings.js';
import { integrations } from './integrations/integrations.js';
import {
  inDevelopment,
  TEST_NOTIFICATIONS,
} from './notifications/notification-test.js';
import { BRANDING_SETTINGS } from './branding/branding.settings.js';
import { DELIVERABILITY_SETTINGS } from './deliverability/mail-delivery.settings.js';
import { QUOTA_SETTINGS } from './quotas/quota.settings.js';
import { NUMBERING_SETTINGS } from './sequences/numbering-settings.js';
import { ACKNOWLEDGMENT_NOTIFICATIONS } from './acknowledgments/acknowledgment-notifications.js';
import { ATTACHMENT_NOTIFICATIONS } from './attachments/attachment-scan.queue.js';
import { COMMENT_NOTIFICATIONS } from './comments/comment-notifications.js';
import { AUTOMATION_NOTIFICATIONS } from './automations/automation-events.js';
import { ModeGuard } from './mode/mode.guard.js';
import { MODE_SETTINGS } from './mode/mode.setting.js';
import { APPROVAL_NOTIFICATIONS } from './approvals/approval-events.js';
import { APPROVAL_SETTINGS } from './approvals/approval-settings.js';
import { MESSAGING_SETTINGS } from './messaging/messaging.settings.js';
import { MoneyModule } from './money/money.module.js';

import { PlatformOpsModule } from './ops/ops.module.js';
import { ConfigBundlesModule } from './config-bundles/config-bundles.module.js';
import { PlatformWebhooksModule } from './webhooks/webhooks.module.js';
import { PlatformIdempotencyModule } from './idempotency/idempotency.module.js';
import { PlatformFeaturesModule } from './features/features.module.js';
import { PlatformStorageModule } from './storage/storage.module.js';
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
 * come from one global module (optionsModule below). Each capability module
 * holds its own routes; the platform's global enhancers stay here (`providers`).
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
        // is global and outermost (this module has no global interceptor of its
        // own, and this is its first import): a replay passes through no other
        // interceptor, so it is neither metered nor held to the quota, and a
        // 403 is stored and replayed like any other 4xx. Guards run before
        // every interceptor, so the scope sees the caller.
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
            // A 429 is not an outcome: the quota's (UsageInterceptor, inside
            // this one) ends at midnight UTC, and the retry must run then.
            storeIf: (status) => status < 500 && status !== 429,
            // Stored responses can hold an endpoint's secret: seal them at rest.
            encryption: { keys: platform.idempotency },
          }),
        }),
        // After IdempotencyModule, whose interceptor must come first, and
        // before every other module with a global interceptor: USAGE=on, its
        // meter is the second, so it counts a request once whatever the
        // route's retries (ResilienceModule, below) do.
        UsageModule,
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
        PlatformStorageModule,
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
        AnalyticsModule,
        RevisionsModule,
        ClientErrorsModule,
        BrandingModule,
        EncryptionModule,
        RetentionModule,
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
