import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { AllowInMaintenance } from '../http/maintenance.js';
import { DatabaseHealth } from '../database/database-health.js';
import { REDIS } from '../redis/redis.js';

/**
 * For Docker's healthcheck, load balancers and orchestrators (@nestjs/terminus):
 *
 * - `GET /health` (readiness): 200 when PostgreSQL and Redis answer, 503 when
 *   one doesn't, or while the app shuts down (stop sending it traffic).
 * - `GET /health/live` (liveness): 200 while the process serves requests.
 */
@ApiExcludeController()
@Public()
@AllowInMaintenance()
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly database: DatabaseHealth,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @HealthCheck()
  ready() {
    return this.health.check([
      () =>
        this.indicator
          .check('database')
          .attempt(() => this.database.ping())
          .withTimeout(2000)
          .cacheFor(1000),
      // The pool's use, for dashboards: informative, never a 503 by itself.
      () =>
        this.indicator
          .check('databasePool')
          .up<Record<string, unknown>>(this.database.pool()),
      () =>
        this.indicator
          .check('redis')
          .attempt(() => this.redis.ping().then(() => undefined))
          .withTimeout(2000)
          .cacheFor(1000),
    ]);
  }

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }
}
