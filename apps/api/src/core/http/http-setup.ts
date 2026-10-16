import { RequestMethod, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Config, CoreEnv } from '../config/core.env.js';
import { assignRequestId } from '../logging/logging.js';

/**
 * The HTTP layer every project keeps: proxy trust, security headers, CORS,
 * CSRF and versioning. Validation is the global pipe I18nModule's
 * catalogs translate (core.module.ts).
 */
export function setupHttp(app: NestExpressApplication) {
  const config = app.get<Config<CoreEnv>>(ConfigService);
  const origins = config.get('CORS_ORIGINS', { infer: true });

  // Behind Caddy: the client's address (for rate limits and the audit log)
  // comes from X-Forwarded-For, trusted from loopback and private networks only.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // First of all: every response, an error of the body parser included, carries its id.
  app.use(assignRequestId);

  // SNS posts its JSON as text/plain (the mail intake, platform/deliverability):
  // parsed as text, with the raw bytes kept (`rawBody`) for the signature
  // check, as the JSON parser keeps them for the other incoming webhooks.
  // SNS messages are at most 256 KB.
  app.useBodyParser('text', { type: 'text/plain', limit: '512kb' });

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

  // Browser apps on other origins (CORS_ORIGINS): they may call the API with
  // the session cookie. Same-origin apps need nothing.
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'Content-Language'],
      maxAge: 600,
    });
  }

  // Refuses writes from other websites' pages with a 403, on every route,
  // including the public sign-in. curl, API clients' systems and webhooks send
  // no Origin or Sec-Fetch-Site and are unaffected. CORS_ORIGINS may write.
  // Signed uploads (PUT /files) carry their credential in the URL, not a cookie.
  app.enableCsrfProtection({
    trustedOrigins: origins,
    exclude: [{ path: 'files', method: RequestMethod.PUT }],
  });

  // /v1/notes: a breaking change ships as /v2 next to it (`@Version('2')`
  // on a route or `@Controller({ version: '2' })`). /health and the docs
  // carry no version.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
