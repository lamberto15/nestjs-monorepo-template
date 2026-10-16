import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { CoreEnv } from '../config/core.env.js';

let warned = false;

/**
 * ThrottlerGuard with every limit multiplied by RATE_LIMIT_MULTIPLIER (1
 * unless set). The load test (docs/development.md, "Load tests") sends every
 * request from one address and signs the same accounts in many times a
 * minute: it raises the limits rather than turning them off, so the guard
 * still runs, and costs, what it costs in production.
 *
 * Custom: @nestjs/throttler resolves a function `limit` for the module's
 * throttlers, but a route's `@Throttle({ limit: 5 })` replaces it with a
 * plain number; scaling the resolved limit in handleRequest covers both.
 */
@Injectable()
export class ScaledThrottlerGuard extends ThrottlerGuard {
  protected readonly multiplier: number;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService<CoreEnv, true>,
  ) {
    super(options, storageService, reflector);
    this.multiplier = config.get('RATE_LIMIT_MULTIPLIER', { infer: true });
    if (this.multiplier !== 1 && !warned) {
      warned = true;
      new Logger('Throttler').warn(
        `RATE_LIMIT_MULTIPLIER=${this.multiplier}: every rate limit is ${this.multiplier} times higher (load tests only).`,
      );
    }
  }

  /** The limit after RATE_LIMIT_MULTIPLIER. */
  protected scaled(limit: number) {
    return limit * this.multiplier;
  }

  protected override handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: this.scaled(requestProps.limit),
    });
  }
}
