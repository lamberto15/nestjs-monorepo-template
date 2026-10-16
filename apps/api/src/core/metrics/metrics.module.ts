import {
  Global,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleInit,
} from '@nestjs/common';
import { DatabaseHealth } from '../database/database-health.js';
import { HttpMetricsMiddleware } from './http-metrics.middleware.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

/** The database pool's connections, by state (core's own gauge). */
@Injectable()
class DatabasePoolMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly database: DatabaseHealth,
  ) {}

  onModuleInit() {
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
