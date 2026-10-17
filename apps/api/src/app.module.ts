import { Module, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FEATURES } from './app.tokens.js';
import { CoreModule } from './core/core.module.js';
import { demoPermissions } from './demo/demo.jobs.js';
import { DEV_ENV_FILE, ignoreDevEnvFile } from './dev-env.js';
import { envSchema } from './env.js';
import {
  type FeatureDefinition,
  featureDeclarations,
} from './features/feature.js';
import { FEATURES } from './features/index.js';
import { CORE_SEED_ROLES } from './iam/access/seed-roles.js';
import { IAM_NOTIFICATIONS } from './iam/iam-notifications.js';
import { IamModule } from './iam/iam.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PLATFORM_PERMISSIONS } from './platform/ops/ops.policy.js';

// The environment, validated by every group's schema (env.ts), the
// secrets' `X_FILE` files read first (core/config/secret-files.ts). In
// development, .env.development adds to it (env.development.example;
// main.ts has already put it into process.env, see dev-env.ts);
// production gets it from Compose, tests from test/setup-env.ts. (.env is
// Docker Compose's own file.)
// Made once per process, however many apps are built (createAppModule):
// it writes the validated values back into process.env, which a second
// validation would read as invalid (`true` isn't `on`).
const CONFIG = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validationSchema: envSchema,
  envFilePath: DEV_ENV_FILE,
  // Only validated values: an empty `FOO=` reads as unset, never as ''.
  skipProcessEnv: true,
  ignoreEnvFile: ignoreDevEnvFile,
});

/**
 * The composition root: the three groups every project keeps, then the
 * features. Groups never import features; features hand them what they
 * declare (permissions, event types, incoming senders, custom fields,
 * approvable actions) through their `<x>.feature.ts`, listed in
 * features/index.ts.
 *
 *   core/      database, rate limiting, health, HTTP setup
 *   iam/       user sign-in, API keys, roles and permissions, audit log
 *   platform/  idempotency, outbox, webhooks, workflows, operations API
 *   features/  your code: one folder and module per feature
 *
 * Built from a list of features (`createAppModule`): the app's are
 * features/index.ts's (AppModule); the tests add a test-only one
 * (test/fixtures), and an app with none still boots.
 */
export function createAppModule(list: readonly FeatureDefinition[]): Type {
  /** What the features declare, merged for the groups. */
  const features = featureDeclarations(list);

  @Module({
    providers: [{ provide: APP_FEATURES, useValue: list }],
    exports: [APP_FEATURES],
    imports: [
      CONFIG,
      // First of the groups: the idempotency interceptor must be outermost, so
      // a replay doesn't pass through the other interceptors (i18n, resilience,
      // authentication) again. Module order only orders global enhancers; the
      // providers resolve whatever the order.
      PlatformModule.forRoot({
        eventTypes: features.eventTypes,
        incomingWebhooks: features.incomingWebhooks,
        queues: features.queues,
        customFields: features.customFields,
        notifications: [...IAM_NOTIFICATIONS, ...features.notifications],
        settings: features.settings,
        // Actions that need approval: docs/approvals.md.
        approvals: features.approvals,
      }),
      // Before IamModule: the rate limit guards before authentication does.
      CoreModule,
      IamModule.forRoot({
        // demoPermissions: the demo seed's system job (src/demo, pnpm db:seed:demo).
        permissions: [
          // First: the seed roles' names (features add their grants by key).
          CORE_SEED_ROLES,
          PLATFORM_PERMISSIONS,
          ...features.permissions,
          demoPermissions(list),
        ],
        // Resources the platform acts on (soft delete: the recycle bin, the purge).
        resources: features.resources,
      }),
      // Features (features/index.ts)
      ...features.modules,
    ],
  })
  class AppModule {}
  return AppModule;
}

/** The app: its features (features/index.ts). main.ts, the worker and the OpenAPI dump boot it. */
export const AppModule = createAppModule(FEATURES);
