import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from './core/core.module.js';
import { DEMO_PERMISSIONS } from './demo/demo.jobs.js';
import { DEV_ENV_FILE, ignoreDevEnvFile } from './dev-env.js';
import { envSchema } from './env.js';
import { EXAMPLE_SENDER } from './features/notes/example-sender-webhook.controller.js';
import { NOTE_EVENT_TYPES } from './features/notes/note-events.js';
import { NOTE_PUBLISH_APPROVAL } from './features/notes/note-approvals.js';
import { NOTE_NOTIFICATIONS } from './features/notes/note-notifications.js';
import { NOTE_SETTINGS } from './features/notes/note-settings.js';
import { NOTE_PERMISSIONS } from './features/notes/note.policy.js';
import { NOTE, NOTE_CUSTOM_FIELDS } from './features/notes/note.resource.js';
import { NotesModule } from './features/notes/notes.module.js';
import { IAM_NOTIFICATIONS } from './iam/iam-notifications.js';
import { IamModule } from './iam/iam.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PLATFORM_PERMISSIONS } from './platform/ops/ops.policy.js';

/**
 * The composition root: the three groups every project keeps, then the
 * features. Groups never import features; features hand them what they
 * declare (permissions, event types, incoming senders, custom fields,
 * approvable actions) here.
 *
 *   core/      database, rate limiting, health, HTTP setup
 *   iam/       user sign-in, API keys, roles and permissions, audit log
 *   platform/  idempotency, outbox, webhooks, workflows, operations API
 *   features/  your code: one folder and module per feature
 */
@Module({
  imports: [
    // The environment, validated by every group's schema (env.ts), the
    // secrets' `X_FILE` files read first (core/config/secret-files.ts). In
    // development, .env.development adds to it (env.development.example;
    // main.ts has already put it into process.env, see dev-env.ts);
    // production gets it from Compose, tests from test/setup-env.ts. (.env is
    // Docker Compose's own file.)
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envSchema,
      envFilePath: DEV_ENV_FILE,
      // Only validated values: an empty `FOO=` reads as unset, never as ''.
      skipProcessEnv: true,
      ignoreEnvFile: ignoreDevEnvFile,
    }),
    // First of the groups: the idempotency interceptor must be outermost, so
    // a replay doesn't pass through the other interceptors (i18n, resilience,
    // authentication) again. Module order only orders global enhancers; the
    // providers resolve whatever the order.
    PlatformModule.forRoot({
      eventTypes: [...NOTE_EVENT_TYPES],
      incomingWebhooks: [EXAMPLE_SENDER],
      customFields: [NOTE_CUSTOM_FIELDS],
      notifications: [...IAM_NOTIFICATIONS, ...NOTE_NOTIFICATIONS],
      settings: [...NOTE_SETTINGS],
      // Actions that need approval: docs/approvals.md.
      approvals: [NOTE_PUBLISH_APPROVAL],
    }),
    // Before IamModule: the rate limit guards before authentication does.
    CoreModule,
    IamModule.forRoot({
      // DEMO_PERMISSIONS: the demo seed's system job (src/demo, pnpm db:seed:demo).
      permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS, DEMO_PERMISSIONS],
      // Resources the platform acts on (soft delete: the recycle bin, the purge).
      resources: [NOTE],
    }),
    // Features
    NotesModule,
  ],
})
export class AppModule {}
