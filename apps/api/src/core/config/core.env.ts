import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  baseUrl,
  flag,
  isTimeZone,
  list,
  optional,
  pathWithDefault,
  secret,
  withDefault,
} from './env.helpers.js';
import { SHIPPED_LOCALES } from '../i18n/locales.js';

/** The environment of the core group: the runtime, HTTP, database, Redis, logs. */
export const coreEnv = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  /**
   * Which deployment this is (`production`, `staging`, `preview-42`…), for
   * logs and traces only. Behaviour follows NODE_ENV, which stays
   * `production` on staging, so staging runs what production runs.
   * `loadtest` names the load test's throwaway stack (compose.loadtest.yaml),
   * the only production deployment allowed RATE_LIMIT_MULTIPLIER above 1.
   */
  APP_ENV: optional(),
  /**
   * What this process does: `api` serves HTTP only, `worker` runs the
   * background work (queue jobs, outbox relay, webhook deliveries, workflow
   * steps, cron jobs), `all` both (development, small deployments).
   * `node dist/main` reads it; `node dist/worker` sets `worker`.
   */
  APP_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** Where this API is reached from outside: OAuth callbacks and signed file URLs are built on it. */
  APP_URL: baseUrl('http://localhost:3000'),
  /**
   * The web app's origin, for the links in emails (reset password, verify
   * email, invitations, magic links). Defaults to APP_URL.
   */
  WEB_URL: baseUrl(),
  /**
   * Origins of browser apps on another origin than the API (comma-separated):
   * CORS, and the origins allowed to send cookie-authenticated writes.
   */
  CORS_ORIGINS: list(),

  /** `json` (one JSON object per line, the default in production) or `text`. */
  LOG_FORMAT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['json', 'text']).optional(),
  ),
  /** The lowest level logged. */
  LOG_LEVEL: z
    .enum(['verbose', 'debug', 'log', 'warn', 'error', 'fatal'])
    .default('log'),
  /** The service's name in logs and traces. */
  SERVICE_NAME: withDefault('nestjs-monorepo-template'),

  /**
   * PostgreSQL 18+, as the app's role: `postgres://role:password@host:5432/db`
   * (development: `pnpm services:up`). The role owns nothing and can't change
   * the schema or bypass row-level security; `node dist/migrate` creates it
   * from this URL (docs/deployment.md, "Database roles").
   */
  DATABASE_URL: secret(
    z
      .string()
      .regex(
        /^postgres(ql)?:\/\//,
        'a postgres:// URL (pnpm services:up runs one)',
      ),
  ),
  /**
   * The same database as the owner of its tables, who runs the migrations:
   * required when MIGRATE_ON_START is on (development); the `migrate`
   * service has it in production, api and worker don't.
   */
  DATABASE_OWNER_URL: secret(
    optional().refine(
      (url) => url === undefined || /^postgres(ql)?:\/\//.test(url),
      'a postgres:// URL',
    ),
  ),
  /**
   * The maintenance role (docs/tenancy.md, "The bypass"): BYPASSRLS, for
   * the worker's jobs that sweep every tenant's rows at once (retention)
   * and the deployment-wide metrics. Only the worker (and `migrate`, which
   * creates the role) gets it; an api process never holds it, so nothing a
   * request runs can read past a tenant. Unset: those jobs refuse to run.
   */
  DATABASE_MAINTENANCE_URL: secret(
    optional().refine(
      (url) => url === undefined || /^postgres(ql)?:\/\//.test(url),
      'a postgres:// URL',
    ),
  ),
  /**
   * Apply pending migrations at startup (under an advisory lock), as
   * DATABASE_OWNER_URL. Production Compose turns it off and runs
   * `node dist/migrate` once per deploy.
   */
  MIGRATE_ON_START: flag('on'),
  /** Statistics only, through an independent single-connection pool. */
  DATABASE_MONITOR_URL: secret(optional()),
  /**
   * The pool, per process (PostgreSQL only). Every process holds up to MAX
   * connections: replicas × MAX for the API, plus the workers', must stay
   * under PostgreSQL's max_connections (100) minus a few for admin and
   * migrations. Workers run steps and jobs in parallel: give them more.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
  /** How long a query waits for a free connection, then 503 database_busy: never hang. */
  DATABASE_POOL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5000),
  /** PostgreSQL cancels a statement running longer (0: never). Migrations have none. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  /** PostgreSQL ends a session left idle inside a transaction this long (0: never). */
  DATABASE_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().min(0).default(60_000),

  /** Redis: queues, shared rate limits, and WebSocket fan-out across instances. */
  REDIS_URL: secret(withDefault('redis://127.0.0.1:6379')),
  /**
   * Redis' password, in place of REDIS_URL's: for one kept in a file
   * (REDIS_PASSWORD_FILE) that the Redis server reads too (compose.prod.yaml).
   */
  REDIS_PASSWORD: secret(optional()),
  /**
   * Redis behind Sentinel, for failover: `host:port` of each sentinel
   * (comma-separated), and the monitored master's name. REDIS_URL then only
   * gives the password, the database number and TLS.
   */
  REDIS_SENTINELS: list(),
  REDIS_SENTINEL_NAME: withDefault('mymaster'),
  /** Prefix of every key and queue this app writes, so apps can share a Redis. */
  REDIS_PREFIX: withDefault('app'),
  /** `memory` keeps rate limits per instance (one instance, or tests). */
  RATE_LIMIT_STORE: z.enum(['redis', 'memory']).default('redis'),
  /**
   * Multiplies every rate limit (the global 600 a minute, each route's
   * `@Throttle()` and `@UserThrottle()`). For the load test's stack only
   * (compose.loadtest.yaml), whose requests all come from one address: limits
   * are raised there, never turned off. Keep it 1 everywhere else: with
   * NODE_ENV=production, above 1 stops the app unless APP_ENV=loadtest
   * (checkRateLimitMultiplier).
   */
  RATE_LIMIT_MULTIPLIER: z.coerce.number().int().min(1).max(100_000).default(1),

  /**
   * The app's IANA time zone: cron jobs run on it, and mail shows times in
   * it to users who chose none. Data and API stay in UTC (ISO 8601).
   */
  APP_TIMEZONE: withDefault('UTC').refine(
    isTimeZone,
    'must be an IANA time zone, e.g. Europe/Berlin',
  ),
  /**
   * Languages the API answers in (catalogs in src/i18n/<locale>); the first
   * is the default. Shipped: en, de, ar (right to left), zh (Simplified), ms.
   */
  LOCALES: list().transform((locales) =>
    locales.length > 0 ? locales : [...SHIPPED_LOCALES],
  ),

  /**
   * How mail leaves: `file` (.eml files in MAIL_DIRECTORY, development),
   * `log` (printed), `smtp` (SMTP_URL), `resend`, `postmark`, `sendgrid`,
   * `ses` (AWS_* credentials), or `memory` (tests).
   */
  MAIL_TRANSPORT: z
    .enum([
      'file',
      'log',
      'smtp',
      'resend',
      'postmark',
      'sendgrid',
      'ses',
      'memory',
    ])
    .default('file'),
  /** The sender of every mail. */
  MAIL_FROM: withDefault('My API <no-reply@example.com>'),
  MAIL_DIRECTORY: pathWithDefault('.data/mail'),
  /** smtp://user:password@smtp.example.com:587 (STARTTLS) or smtps://…:465. */
  SMTP_URL: secret(optional()),
  /** The API key or token of the HTTP provider MAIL_TRANSPORT names. */
  MAIL_API_KEY: secret(optional()),
  /** SES's endpoint: unset for AWS; http://localhost:4566 for Floci (development). */
  SES_ENDPOINT: optional(),

  /**
   * AWS (SES, S3). Read here, not by the packages from process.env: values in
   * .env.development never reach process.env (skipProcessEnv). Unset keys:
   * the packages fall back to process.env (an instance role's exported keys).
   */
  AWS_REGION: optional(),
  AWS_ACCESS_KEY_ID: optional(),
  AWS_SECRET_ACCESS_KEY: secret(optional()),
  AWS_SESSION_TOKEN: secret(optional()),

  /** Cron jobs (@Cron): off for an instance that only serves requests, and in tests. */
  SCHEDULER: flag('on'),

  /** NestJS Observe (traces, metrics, errors): on when both keys are set. */
  OBSERVE_APP_KEY: secret(optional()),
  OBSERVE_APP_SECRET: secret(optional()),
  /**
   * OpenTelemetry export (traces and metrics over OTLP/HTTP, on when the
   * endpoint is set). The SDK also reads the standard `OTEL_*` variables
   * itself (OTEL_SERVICE_NAME, OTEL_TRACES_SAMPLER, …); `OTEL_EXPORTER_OTLP_HEADERS`
   * (`x-honeycomb-team=…`) carries the collector's credential.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: optional().refine(
    (url) => url === undefined || /^https?:\/\//.test(url),
    'must be an http(s) URL',
  ),
  OTEL_EXPORTER_OTLP_HEADERS: secret(optional()),
  /** Sentry error tracking: on when the DSN is set. */
  SENTRY_DSN: secret(optional()),
  /** 0 to 1: the share of requests Sentry traces; unset, errors only. */
  SENTRY_TRACES_SAMPLE_RATE: optional(),
  /** Off for the docs at /api in production. */
  OPENAPI: flag('on'),
  /** Data import size ceiling, in bytes; settings may only lower it. */
  IMPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  /** Data import row ceiling; settings may only lower it. */
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(1_000_000),
  /** Disk-backed scratch directory for staged and expanded data imports. */
  IMPORT_TEMP_DIR: pathWithDefault('.data/import-scratch'),
  /**
   * Seal sorted lists' cursors (`nextCursor`, core/http/cursor-seal.ts): keys
   * newest first, comma-separated. Unset: created once, kept in the database.
   */
  CURSOR_KEYS: secret(optional()),
  /**
   * Personal data at rest (docs/encryption.md): the keys of the encrypted
   * columns, newest first, comma-separated (each `openssl rand -base64 32`).
   * Never created by the app and never kept in the database: a key next to
   * its ciphertext protects nothing in a backup. Required at boot once a
   * column is declared encrypted.
   */
  DATA_ENCRYPTION_KEYS: secret(list()),
  /**
   * The keys of the encrypted columns' blind indexes (HMAC-SHA-256), newest
   * first; none of DATA_ENCRYPTION_KEYS. Required at boot once a column
   * declares a blind index.
   */
  BLIND_INDEX_KEYS: secret(list()),
  /**
   * Prometheus' bearer token for GET /metrics (at least 16 characters);
   * unset, /metrics answers 404.
   */
  METRICS_TOKEN: secret(
    optional().refine(
      (token) => token === undefined || token.length >= 16,
      'at least 16 characters (openssl rand -hex 24)',
    ),
  ),
  /**
   * Jobs the mail queue's worker runs at once in this process. Every queue
   * has one such variable, `QUEUE_CONCURRENCY_<QUEUE NAME>` (dashes as
   * underscores), declared in its own group; QueueWorkers applies them.
   */
  QUEUE_CONCURRENCY_MAIL: z.coerce.number().int().min(1).default(5),
});

export type CoreEnv = z.output<typeof coreEnv>;

/**
 * A production app never runs with raised rate limits by accident (the load
 * test's overlay added to a deployment's COMPOSE_FILE, a stray variable):
 * RATE_LIMIT_MULTIPLIER above 1 under NODE_ENV=production needs
 * APP_ENV=loadtest, which only compose.loadtest.yaml sets. Checked on the
 * whole environment (env.ts), after each variable parsed.
 */
export const rateLimitMultiplierAllowed = (
  env: Pick<CoreEnv, 'NODE_ENV' | 'APP_ENV' | 'RATE_LIMIT_MULTIPLIER'>,
) =>
  env.RATE_LIMIT_MULTIPLIER === 1 ||
  env.NODE_ENV !== 'production' ||
  env.APP_ENV === 'loadtest';

export const RATE_LIMIT_MULTIPLIER_REFUSED = {
  path: ['RATE_LIMIT_MULTIPLIER'],
  message:
    'above 1 only for the load test: with NODE_ENV=production it needs APP_ENV=loadtest (compose.loadtest.yaml)',
};

/** `ConfigService`, typed by a group's environment: `config.get('PORT', { infer: true })`. */
export type Config<Env> = ConfigService<Env, true>;

/** Whether this process runs the background work (APP_ROLE `worker` or `all`). */
export const runsWorkers = (env: NodeJS.ProcessEnv = process.env) =>
  env.APP_ROLE !== 'api';

/** The deployment's name: APP_ENV, else NODE_ENV. */
export const appEnv = (config: Config<CoreEnv>) =>
  config.get('APP_ENV', { infer: true }) ??
  config.get('NODE_ENV', { infer: true });

/** The web app's URL: WEB_URL, else APP_URL. */
export const webUrl = (config: Config<CoreEnv>) =>
  config.get('WEB_URL', { infer: true }) ??
  config.get('APP_URL', { infer: true });

/** The AWS keys from the validated environment, or undefined (the packages' own default). */
export function awsCredentials(config: Config<CoreEnv>) {
  const accessKeyId = config.get('AWS_ACCESS_KEY_ID', { infer: true });
  const secretAccessKey = config.get('AWS_SECRET_ACCESS_KEY', { infer: true });
  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }
  const sessionToken = config.get('AWS_SESSION_TOKEN', { infer: true });
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken && { sessionToken }),
  };
}
