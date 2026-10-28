import { RequestMethod, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeAdapter, type NestNodeApplication } from '@nestjs/platform-node';
import compression from 'compression';
import type { Config, CoreEnv } from '../config/core.env.js';
import { assignRequestId } from '../logging/logging.js';
import { JSON_BODY_LIMIT } from './body-limit.js';
import { recordMatchedRoutes } from './route-key.js';

/** The response headers a browser app on CORS_ORIGINS may read (`Access-Control-Expose-Headers`). */
export const CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'Retry-After',
  'Content-Language',
  'ETag',
  'Location',
  'Idempotent-Replayed',
] as const;

/** The longest path parameter a route matches, in characters (decoded). */
export const MAX_PARAM_LENGTH = 2048;

/**
 * The HTTP server: Nest's native `node:http` adapter (@nestjs/platform-node),
 * which main.ts and the tests both create the app with.
 *
 * Behind Caddy: the client's address (for rate limits and the audit log)
 * comes from X-Forwarded-For, trusted from loopback and private networks
 * only. Addresses, never a hop count: the adapter trusts no proxy for a
 * number (it can't tell a proxy from a client sending its own header).
 */
export function createHttpAdapter() {
  const adapter = new NodeAdapter({
    trustProxy: 'loopback, linklocal, uniquelocal',
    // A path parameter longer than this is a 414 (the adapter's default is
    // 100): the one-click unsubscribe link carries a signed JWT in its path
    // (`/v1/notifications/unsubscribe/:token`, a few hundred characters).
    maxParamLength: MAX_PARAM_LENGTH,
  });
  recordMatchedRoutes(adapter.getInstance());
  // The JSON parser's SyntaxError (an http-error, 400) reaches the filters
  // as it is: the adapter would make it a BadRequestException carrying the
  // parser's message, which quotes the body. ProblemDetailsFilter answers
  // it with the status's own words, as every other parser error.
  const mapException = adapter.mapException.bind(adapter);
  adapter.mapException = (error: unknown) =>
    error instanceof SyntaxError && 'statusCode' in error
      ? error
      : mapException(error);
  return adapter;
}

/**
 * The HTTP layer every project keeps: proxy trust, security headers, CORS,
 * CSRF and versioning. Validation is the global pipe I18nModule's
 * catalogs translate (core.module.ts).
 */
export function setupHttp(app: NestNodeApplication) {
  const config = app.get<Config<CoreEnv>>(ConfigService);
  const origins = config.get('CORS_ORIGINS', { infer: true });

  // First of all: every response, an error of the body parser included, carries its id.
  app.use(assignRequestId);

  // SNS posts its JSON as text/plain (the mail intake, platform/deliverability):
  // parsed as text, with the raw bytes kept (`rawBody`) for the signature
  // check, as the JSON parser keeps them for the other incoming webhooks.
  // SNS messages are at most 256 KB.
  app.useBodyParser('text', { type: 'text/plain', limit: '512kb' });
  // JSON bodies: up to JSON_BODY_LIMIT (body-limit.ts), then 413
  // payload_too_large. Registered here, Nest's own JSON parser is skipped;
  // rawBody (main.ts) is kept for the incoming webhooks' signatures.
  // SCIM's media type (iam/sso/scim) is JSON too.
  app.useBodyParser('json', {
    type: ['application/json', 'application/*+json'],
    limit: JSON_BODY_LIMIT,
  });
  // HTML form posts: only SAML's HTTP-POST binding sends them (the
  // assertion consumer service, iam/sso), a signed assertion of a few KB.
  app.useBodyParser('urlencoded', {
    extended: false,
    limit: '512kb',
    parameterLimit: 10,
  });

  // HSTS, nosniff, frame-ancestors 'none', a strict CSP (Swagger UI's assets
  // are served from this origin, so it works with the default policy)...
  app.useSecurityHeaders({
    // Two years, subdomains included: the app is only ever served over HTTPS.
    strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true },
    // Plain-HTTP development would otherwise have Swagger UI's assets upgraded to https://.
    ...(config.get('NODE_ENV', { infer: true }) !== 'production' && {
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  });

  // gzip responses the web app's `encode` never reaches: Caddy skips `/v1/*`
  // because its `encode` would suffix the strong ETags etag.ts sends
  // (docs/deployment.md, "Compression"). `compression` (a connect middleware,
  // on the adapter's plain node:http response) leaves ETag and every other
  // header untouched, so no suffix, no mismatch to work
  // around. `text/event-stream` isn't in the compressible media types (no
  // `compressible` entry for it), so the ops event stream (GET
  // /v1/ops/events) still flushes each event unbuffered, uncompressed.
  app.use(compression());

  // Browser apps on other origins (CORS_ORIGINS): they may call the API with
  // the session cookie. Same-origin apps need nothing.
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      credentials: true,
      // What a browser app may read: ETag (If-Match, If-None-Match),
      // Location, and Idempotent-Replayed (@nestjs/idempotency's checklist).
      exposedHeaders: [...CORS_EXPOSED_HEADERS],
      maxAge: 600,
    });
  }

  // Refuses writes from other websites' pages with a 403, on every route,
  // including the public sign-in. curl, API clients' systems and webhooks send
  // no Origin or Sec-Fetch-Site and are unaffected. CORS_ORIGINS may write.
  // Signed uploads (PUT /files) carry their credential in the URL, not a cookie.
  // A SAML IdP's page posts its response to the assertion consumer service
  // from its own origin, by design: the browser's binding cookie and the
  // response's InResponseTo replace the check there, and that route signs
  // nobody in (its GET follow-up does, same-site).
  app.enableCsrfProtection({
    trustedOrigins: origins,
    exclude: [
      { path: 'files', method: RequestMethod.PUT },
      {
        path: 'auth/sso/:tenantId/:connectionId/saml/acs',
        method: RequestMethod.POST,
        version: '1',
      },
    ],
  });

  // /v1/notes: a breaking change ships as /v2 next to it (`@Version('2')`
  // on a route or `@Controller({ version: '2' })`). /health and the docs
  // carry no version.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
