import { AllowInMaintenance } from '../http/maintenance.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Res,
  UnauthorizedException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '@nestjs/authentication';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { NodeResponse as Response } from '@nestjs/platform-node';
import type { CoreEnv } from '../config/core.env.js';
import { MetricsService } from './metrics.service.js';

/** Equal strings, compared in constant time (their SHA-256, so lengths don't leak). */
const sameSecret = (given: string, expected: string) =>
  timingSafeEqual(
    createHash('sha256').update(given).digest(),
    createHash('sha256').update(expected).digest(),
  );

/**
 * `GET /metrics`: Prometheus' scrape. Off (404) unless METRICS_TOKEN is set;
 * then only with `Authorization: Bearer <METRICS_TOKEN>`. Scrape it from
 * inside the private network: the proxy doesn't route it (docs/deployment.md).
 * Not an API route: no version, not in the OpenAPI document, never cached.
 * Not rate limited, like /health: the limiter counts in Redis, so with Redis
 * away every scrape hung until Prometheus gave up, and the alerts saw the
 * app down instead of the gauges that name Redis.
 */
@ApiExcludeController()
@Public()
@AllowInMaintenance()
@SkipThrottle()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  private readonly token: string | undefined;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService<CoreEnv, true>,
  ) {
    this.token = config.get('METRICS_TOKEN', { infer: true });
  }

  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ) {
    if (!this.token) {
      throw new NotFoundException();
    }
    const given = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1] ?? '';
    if (!sameSecret(given, this.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      throw new UnauthorizedException('A valid metrics token is required.');
    }
    const { contentType, body } = await this.metrics.scrape();
    // Written as is: Express' res.send() would reorder the content type's parameters.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }
}
