import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { APP_FEATURES } from './app.tokens.js';
import type { FeatureDefinition } from './features/feature.js';
import {
  applyIdempotencyMode,
  swaggerRequestInterceptor,
} from './platform/idempotency/idempotency.openapi.js';
import type { PlatformEnv } from './platform/platform.env.js';
import { addRealtimeEvents } from './platform/realtime/realtime-events.js';
import { addPanelComponents } from './platform/records/panel-components.js';

/** Your API's name, in the document and Swagger UI's title. */
const API_TITLE = 'My API';

/**
 * Serves the OpenAPI document at `/api-json` (and `/api-yaml`), with Swagger UI
 * at `/api`. Request bodies, query parameters and responses come from the Zod
 * schemas on the routes (`@Body({ schema })`, `standardSchema`): Zod 4.2+
 * converts itself, so no converter is configured.
 */
export function setupOpenApi(app: INestApplication) {
  const idempotency = app
    .get<ConfigService<PlatformEnv, true>>(ConfigService)
    .get('IDEMPOTENCY', { infer: true });
  SwaggerModule.setup(
    'api',
    app,
    () => buildOpenApiDocument(app, idempotency),
    {
      customSiteTitle: API_TITLE,
      swaggerOptions: {
        // A fresh Idempotency-Key per Execute when the field is left at "generate".
        requestInterceptor: swaggerRequestInterceptor,
      },
    },
  );
}

/**
 * The OpenAPI document of the app's routes: what `/api-json` serves, and what
 * `pnpm openapi:dump` writes for the typed client (packages/api-client).
 * `idempotency` is the deployment's IDEMPOTENCY; the dump (preview mode, no
 * config) and so the committed client use the default, `required`.
 */
export function buildOpenApiDocument(
  app: INestApplication,
  idempotency: PlatformEnv['IDEMPOTENCY'] = 'required',
) {
  const builder = new DocumentBuilder()
    .setTitle(API_TITLE)
    .setDescription(
      [
        'Rename and describe your API here (src/openapi.ts).',
        '',
        "Outgoing webhooks are signed with Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`) using the endpoint's `whsec_…` secret, and carry `{ type, timestamp, data }`.",
      ].join('\n'),
    )
    .setVersion('1.0')
    .addTag('auth', 'Sign-in, sign-up, sessions, tokens and providers')
    .addTag(
      'account',
      'The signed-in user: profile, password, email, two-factor',
    )
    .addTag('access', 'Roles, users, API clients and the audit log')
    .addTag('ops', 'What runs in the background')
    .addTag(
      'data',
      'Exports and imports (CSV, JSON, Excel), as background jobs',
    );
  // Each feature's tag (its `<x>.feature.ts`), in the features' order.
  for (const { apiTag } of app.get<FeatureDefinition[]>(APP_FEATURES, {
    strict: false,
  })) {
    builder.addTag(apiTag.name, apiTag.description);
  }
  const config = builder
    .addTag('webhooks', "An API client's subscriptions and delivery log")
    .addTag('incoming webhooks', 'Signed webhooks this API receives')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'An API client key (POST /access/clients): sk_<id>_<secret>.',
      },
      'api-key',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'A user access token for mobile apps and CLIs (POST /v1/auth/token), 15 minutes; renew it with POST /v1/auth/token/refresh.',
      },
      'user-token',
    )
    .addCookieAuth(
      '__Host-sid',
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'A user session: POST /v1/auth/sign-in sets the cookie, and Swagger UI on this site sends it.',
      },
      'user-session',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // The record panels' shared components, even with no panel route.
  addPanelComponents(document);
  // The realtime events: their payload components and `x-realtime-events`.
  addRealtimeEvents(document);
  applyIdempotencyMode(document, idempotency);
  return document;
}
