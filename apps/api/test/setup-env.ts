import { randomBytes, randomUUID } from 'node:crypto';
import { inject } from 'vitest';

/**
 * The environment of every e2e test file, set before AppModule loads (its
 * ConfigModule validates it then). Secrets are made up per run, so none is
 * committed; the background workers are off, the tests drive them.
 */
Object.assign(process.env, {
  NODE_ENV: 'test',
  REDIS_URL: inject('redisUrl'),
  // Each file's keys, queues and socket.io channels apart from the others'.
  REDIS_PREFIX: `test-${randomUUID().slice(0, 8)}`,
  // Validated at boot; each app gets a database of its own (support.ts
  // bootApp), a copy of the migrated template, as the run's app role: nothing
  // to migrate at start, and the pool CoreModule makes on this URL (the
  // server's `postgres` database) must not touch it.
  DATABASE_URL: inject('appUrl'),
  MIGRATE_ON_START: 'off',
  APP_URL: 'http://127.0.0.1',
  WEB_URL: 'https://web.example.com',
  LOCALES: 'en,de,ar,zh,ms',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: randomBytes(18).toString('base64url'),
  // The suites sign in as the seeded administrator at once; onboarding.e2e-spec.ts turns it on.
  ADMIN_ONBOARDING: 'off',
  // The fixtures declare an encrypted column (test/fixtures/encrypted): its
  // keys are required at boot (docs/encryption.md).
  DATA_ENCRYPTION_KEYS: randomBytes(32).toString('base64'),
  BLIND_INDEX_KEYS: randomBytes(32).toString('base64'),
  // feature:notes begin
  EXAMPLE_SENDER_WEBHOOK_SECRET: `whsec_${randomBytes(32).toString('base64')}`,
  NOTE_PUBLISH_DELAY: '10s',
  // feature:notes end
  // supertest speaks plain HTTP, where a browser drops Secure cookies.
  SESSION_COOKIE_SECURE: 'off',
  // Off by default (a privileged tool); the impersonation suites need it.
  // deployment-switches.e2e-spec.ts turns it off on a running app.
  IMPERSONATION: 'on',
  OUTBOX_RELAY: 'off',
  WEBHOOKS_WORKER: 'off',
  QUEUES_WORKER: 'off',
  SCHEDULER: 'off',
  WEBHOOKS_ALLOW_LOOPBACK: 'on',
  MAIL_TRANSPORT: 'memory',
  // Never the real Pwned Passwords API from a test: breached-passwords.e2e-spec.ts
  // turns the check on against a stub on loopback.
  PASSWORD_BREACH_CHECK: 'off',
  // Never the real ECB from a test: money.e2e-spec.ts turns the rates job on
  // against a stub on loopback.
  EXCHANGE_RATES_FETCH: 'off',
  STORAGE_DRIVER: 'memory',
});

// The "e2e with telemetry on" CI job sets OTEL_EXPORTER_OTLP_ENDPOINT and
// SENTRY_DSN (a stub collector, test/telemetry-stub.mjs): start the SDKs as
// main.ts does, so the suite runs with the instrumentation patching http,
// Express, pg and ioredis (issue #404, as #392 for NestJS Observe).
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.SENTRY_DSN) {
  await import('../src/core/observability/instrument.js');
}
