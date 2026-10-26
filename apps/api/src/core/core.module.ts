import { randomBytes } from 'node:crypto';
import {
  type ExecutionContext,
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import {
  DatabaseHealth,
  DatabasePoolMonitor,
} from './database/database-health.js';
// Overload errors (pool exhausted, statement timeout) as 503 problems.
import './database/database-errors.js';
// Work on tenant tables without a tenant as 403 tenant_required.
import './tenancy/tenancy-errors.js';
import { ConditionalModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE, DiscoveryModule } from '@nestjs/core';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { ClsModule, type ClsService } from 'nestjs-cls';
import { DrizzleTransactionAdapter } from './database/transactions.js';
import { I18nStandardSchemaValidationPipe } from '@nestjs/i18n';
import { LocksModule } from '@nestjs/locks';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { ThrottlerModule, minutes } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Redis } from 'ioredis';
import { type Config, type CoreEnv, runsWorkers } from './config/core.env.js';
import {
  createDatabase,
  type Database,
  loadOrCreateSecret,
} from './database/drizzle.js';
import { useCursorKeys } from './http/cursor-seal.js';
import { HealthController } from './health/health.controller.js';
import { AppThrottlerGuard } from './http/throttler.guard.js';
import {
  ProblemDetailsFilter,
  validationException,
} from './http/problem-details.filter.js';
import { i18n } from './i18n/i18n.js';
import { DrizzleLockStore } from './locks/drizzle-lock.store.js';
import { RequestLogMiddleware } from './logging/logging.js';
import { mail } from './mail/mail.js';
import { MAIL_QUEUE, MailProcessor, MailQueue } from './mail/mail-queue.js';
import { QueueWorkers, queueRoot } from './queues/queues.js';
import { BullModule } from '@nestjs/bullmq';
import { ErrorTracker, errorTracker } from './observability/error-tracker.js';
import { observability } from './observability/observe.js';
import { REDIS } from './redis/redis.js';
import { RedisModule } from './redis/redis.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { TenantQuotas } from './tenancy/tenant-quotas.js';
import { Tenancy } from './tenancy/tenancy.service.js';
import { EncryptionService } from './encryption/encryption.service.js';
import {
  NO_TENANT,
  TENANT_SCOPE,
  tenantScope,
} from './tenancy/tenant-scope.js';

/**
 * What everything else stands on: the database (PostgreSQL on DATABASE_URL,
 * migrated by Drizzle at startup), Redis, rate limiting,
 * validation and translations, mail, distributed locks and cron jobs, logs and
 * traces, and the health checks. The
 * HTTP setup (security headers, CORS, CSRF, versioning) is in
 * http/http-setup.ts, applied by main.ts and the tests. ConfigModule is
 * registered by AppModule, which knows every group's environment schema.
 */
/** Set once the cursor keys are in place (the provider's value says nothing more). */
const CURSOR_KEYS = Symbol('CURSOR_KEYS');

@Global()
@Module({
  imports: [
    DrizzleModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: Config<CoreEnv>) => ({
        db: await createDatabase({
          url: config.get('DATABASE_URL', { infer: true }),
          ownerUrl: config.get('DATABASE_OWNER_URL', { infer: true }),
          monitorUrl: config.get('DATABASE_MONITOR_URL', { infer: true }),
          // Workers only (Compose gives it to them alone): the bypass's pool.
          maintenanceUrl: runsWorkers()
            ? config.get('DATABASE_MAINTENANCE_URL', { infer: true })
            : undefined,
          migrate: config.get('MIGRATE_ON_START', { infer: true }),
          pool: {
            max: config.get('DATABASE_POOL_MAX', { infer: true }),
            timeoutMs: config.get('DATABASE_POOL_TIMEOUT_MS', { infer: true }),
            statementTimeoutMs: config.get('DATABASE_STATEMENT_TIMEOUT_MS', {
              infer: true,
            }),
            idleTxTimeoutMs: config.get('DATABASE_IDLE_TX_TIMEOUT_MS', {
              infer: true,
            }),
            applicationName: `${config.get('SERVICE_NAME', { infer: true })}:${config.get('APP_ROLE', { infer: true })}`,
          },
        }),
      }),
    }),
    // Transactions that follow the call (core/database/transactions.ts): inside
    // one, every service reading txHost.tx joins it. Every request runs in
    // a CLS context of its own (the middleware), which PrincipalGuard gives
    // the principal's tenant (docs/tenancy.md).
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
      // WebSocket gateways get no global enhancers and no middleware: a
      // gateway binds ClsInterceptor (platform/realtime), whose context
      // takes the tenant of the socket's principal, as PrincipalGuard does
      // for HTTP (the guard ran first, outside any context).
      interceptor: { mount: false, setup: socketTenantSetup },
      plugins: [
        new ClsPluginTransactional({
          adapter: new DrizzleTransactionAdapter({
            drizzleInstanceToken: getDrizzleToken(),
          }),
        }),
      ],
    }),
    RedisModule,
    // Prometheus metrics at GET /metrics (METRICS_TOKEN); global MetricsService.
    MetricsModule,
    // DiscoveryService: QueueWorkers finds the queue workers to stop on shutdown.
    DiscoveryModule,
    // 600 requests a minute per IP; routes tighten it with @Throttle() (sign-in:
    // 5 per 15 min). Counted in Redis, so the limit holds across instances.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS],
      useFactory: (config: Config<CoreEnv>, redis: Redis) => ({
        throttlers: [{ ttl: minutes(1), limit: 600 }],
        errorMessage: 'Too many requests: try again later.',
        storage:
          config.get('RATE_LIMIT_STORE', { infer: true }) === 'redis'
            ? new ThrottlerStorageRedisService(redis)
            : undefined,
      }),
    }),
    // On SIGTERM, /health answers 503 for 5s before the app stops, so the proxy stops sending traffic first.
    TerminusModule.forRoot({ gracefulShutdownTimeoutMs: 5000 }),
    i18n(),
    observability(),
    mail(),
    // BullMQ, and the queue every mail goes through.
    queueRoot(),
    BullModule.registerQueue({ name: MAIL_QUEUE }),
    // Distributed locks in PostgreSQL (DrizzleLockStore): Locks.withLock(), and
    // @OnOneInstance() / @WithoutOverlapping() next to @Cron().
    LocksModule.forRoot(),
    // @Cron() jobs; SCHEDULER=off leaves them out (API-only instances, tests).
    ConditionalModule.registerWhen(
      ScheduleModule.forRoot(),
      (env) => env.SCHEDULER !== 'off' && runsWorkers(env),
      // The wait starts when this file is imported, before ConfigModule.forRoot
      // runs: 5 s (the default) ran out under load (e2e on a busy machine).
      { debug: false, timeout: 60_000 },
    ),
  ],
  controllers: [HealthController],
  exports: [MailQueue, BullModule, Tenancy, TenantQuotas, EncryptionService],
  providers: [
    Tenancy,
    // Tenant limits (members, API clients, storage, records): docs/tenancy.md, "Quotas".
    TenantQuotas,
    // Personal data at rest: the encrypted columns' keys (docs/encryption.md).
    EncryptionService,
    // The keys sorted lists' cursors are sealed with (CURSOR_KEYS, else the
    // one created in app_secrets): every api and worker instance shares them.
    {
      provide: CURSOR_KEYS,
      inject: [getDrizzleToken()],
      useFactory: async (db: Database) => {
        const keys = (
          await loadOrCreateSecret(db, 'CURSOR_KEYS', () =>
            randomBytes(32).toString('base64'),
          )
        ).split(',');
        useCursorKeys(keys);
        return true;
      },
    },
    DrizzleLockStore,
    DatabaseHealth,
    DatabasePoolMonitor,
    QueueWorkers,
    MailQueue,
    MailProcessor,
    // Global, and registered before IamModule's authentication guard: guessed credentials count too.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    // Validates every @Body({ schema }) / @Query({ schema }) with its Zod schema, with
    // messages in the request's language. transform: the handler gets the parsed value.
    {
      provide: APP_PIPE,
      useValue: new I18nStandardSchemaValidationPipe({
        transform: true,
        // One entry per field: { path, message }, in the problem's `errors`.
        exceptionFactory: validationException,
      }),
    },
    // Every error as RFC 9457 problem details (application/problem+json).
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    // Unexpected errors go to Sentry when SENTRY_DSN is set (observability/error-tracker.ts).
    { provide: ErrorTracker, useFactory: () => errorTracker() },
  ],
})
export class CoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLogMiddleware).forRoutes('*path');
  }
}

/**
 * The tenant of a socket message's context: its principal's (the
 * authentication guard mirrored it on the socket as `user`; the handshake
 * kept it in `data.principal`). Never the system principal's, which no
 * socket carries; a guest or a user without a tenant has none.
 */
function socketTenantSetup(cls: ClsService, context: ExecutionContext) {
  if (context.getType() !== 'ws') {
    return;
  }
  const socket = context.switchToWs().getClient<{
    user?: { kind?: string; tenantId?: string | null } | null;
    data?: { principal?: { kind?: string; tenantId?: string | null } };
  }>();
  const principal = socket.user ?? socket.data?.principal;
  cls.set(
    TENANT_SCOPE,
    principal?.kind !== 'system' && principal?.tenantId
      ? tenantScope(principal.tenantId)
      : NO_TENANT,
  );
}
