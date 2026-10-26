import {
  Global,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DatabaseHealth } from '../database/database-health.js';
import { HttpMetricsMiddleware } from './http-metrics.middleware.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

/** The database pool's connections, by state (core's own gauge). */
@Injectable()
class DatabasePoolMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly unsubscribe: (() => void)[] = [];
  constructor(
    private readonly metrics: MetricsService,
    private readonly database: DatabaseHealth,
  ) {}

  onModuleInit() {
    const observer = this.database.observer();
    if (observer) {
      this.unsubscribe.push(
        observer.subscribe((sample) => {
          const duration = sample.durationMs / 1000;
          if (sample.phase === 'acquire')
            this.metrics.databaseAcquire.observe(
              { outcome: sample.outcome },
              duration,
            );
          else
            this.metrics.databaseQuery.observe(
              { operation: sample.operation, outcome: sample.outcome },
              duration,
            );
        }),
        observer.incidents.subscribe((incident) => {
          this.metrics.databaseIncidents.inc({ trigger: incident.trigger });
          if (
            incident.trigger === 'database_busy' ||
            incident.trigger === 'database_timeout'
          ) {
            this.metrics.databaseFailures.inc({ code: incident.trigger });
            this.metrics.databaseLastFailure.set(
              { code: incident.trigger },
              Date.now() / 1000,
            );
          }
        }),
      );
    }
    this.metrics.collect(
      'db_pool_max_connections',
      'Configured application pool connection limit.',
      () => [{ value: this.database.pool().max }],
    );
    this.metrics.collect(
      'db_pool_connections',
      "This process's PostgreSQL pool: connections open (total), idle, and queries waiting for one.",
      () => {
        const pool = this.database.pool();
        return [
          { labels: { state: 'total' }, value: pool.inUse + pool.idle },
          { labels: { state: 'idle' }, value: pool.idle },
          { labels: { state: 'waiting' }, value: pool.waiting },
        ];
      },
      ['state'],
    );
  }

  onModuleDestroy() {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}

/**
 * Prometheus metrics at `GET /metrics` (METRICS_TOKEN): HTTP durations by
 * route pattern, requests in flight, the database pool, Node's defaults.
 * Global: other groups inject MetricsService and `collect()` their gauges.
 */
@Global()
@Module({
  controllers: [MetricsController],
  // DatabaseHealth: CoreModule's, stateless; this module's own instance reads the same pool.
  providers: [MetricsService, DatabaseHealth, DatabasePoolMetrics],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*path}');
  }
}
