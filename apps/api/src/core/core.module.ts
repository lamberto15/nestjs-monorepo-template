import {
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
import { ConditionalModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE, DiscoveryModule } from '@nestjs/core';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { ClsModule } from 'nestjs-cls';
import { DrizzleTransactionAdapter } from './database/transactions.js';
import { I18nStandardSchemaValidationPipe } from '@nestjs/i18n';
import { LocksModule } from '@nestjs/locks';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { ThrottlerModule, minutes } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Redis } from 'ioredis';
import { type Config, type CoreEnv, runsWorkers } from './config/core.env.js';
import { createDatabase } from './database/drizzle.js';
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
import { observability } from './observability/observe.js';
import { REDIS } from './redis/redis.js';
import { RedisModule } from './redis/redis.module.js';
import { MetricsModule } from './metrics/metrics.module.js';

/**
 * What everything else stands on: the database (PostgreSQL on DATABASE_URL,
 * migrated by Drizzle at startup), Redis, rate limiting,
 * validation and translations, mail, distributed locks and cron jobs, logs and
 * traces, and the health checks. The
 * HTTP setup (security headers, CORS, CSRF, versioning) is in
 * http/http-setup.ts, applied by main.ts and the tests. ConfigModule is
 * registered by AppModule, which knows every group's environment schema.
 */
@Global()
@Module({
  imports: [
    DrizzleModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: Config<CoreEnv>) => ({
        db: await createDatabase({
          url: config.get('DATABASE_URL', { infer: true }),
          ownerUrl: config.get('DATABASE_OWNER_URL', { infer: true }),
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
    // one, every service reading txHost.tx joins it.
    ClsModule.forRoot({
      global: true,
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
  exports: [MailQueue, BullModule],
  providers: [
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
  ],
})
export class CoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLogMiddleware).forRoutes('*path');
  }
}
