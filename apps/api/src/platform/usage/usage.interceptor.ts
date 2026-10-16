import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Principal } from '../../iam/auth/principal.js';
import { routeKey, secondsToUtcMidnight } from './usage-keys.js';
import { UsageService } from './usage.service.js';

/** Routes that are never metered: health checks and the API docs. */
const UNMETERED = /^\/(health|api)(\/|$)/;

/**
 * Meters API clients: before the handler, a client over its daily quota
 * gets a 429 `quota_exceeded`; after the response, the request is counted
 * per UTC day and route (UsageService.count, fire and forget). Users,
 * guests, /health and /api are not counted.
 *
 * An interceptor, not a guard: guards run before authentication's global
 * guard (PlatformModule's come first), interceptors after it, so the
 * principal (with its quota, loaded with the key) is known. @nestjs/throttler
 * limits per time window; a daily quota per client read from the client's
 * row and live counters is not something it offers.
 *
 * The quota is exact: a request takes its place in today's total on entry,
 * atomically (UsageService.take), so a burst of parallel requests gets
 * exactly the quota through; its route is counted after the response.
 */
@Injectable()
export class UsageInterceptor implements NestInterceptor {
  constructor(private readonly usage: UsageService) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: Principal | null }>();
    const res = http.getResponse<Response>();
    const principal = req.user;
    if (
      principal?.kind !== 'client' ||
      !req.route ||
      UNMETERED.test(req.path)
    ) {
      return next.handle();
    }
    const quota = principal.dailyQuota ?? null;
    if (quota !== null) {
      const { allowed, used } = await this.usage.take(principal.id, quota);
      res.setHeader('X-Quota-Limit', String(quota));
      if (!allowed) {
        const reset = secondsToUtcMidnight();
        res.setHeader('X-Quota-Remaining', '0');
        res.setHeader('X-Quota-Reset', String(reset));
        res.setHeader('Retry-After', String(reset));
        throw new HttpException(
          {
            code: 'quota_exceeded',
            message: `The daily quota of ${quota} requests is used up; it starts again at midnight UTC.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (used !== null) {
        res.setHeader('X-Quota-Remaining', String(Math.max(0, quota - used)));
      }
    }
    const route = routeKey(
      req.method,
      `${req.baseUrl}${String(req.route.path)}`,
    );
    // 'close', not 'finish': it also fires when the caller hangs up mid-response,
    // so closing the connection doesn't get a request off the meter.
    res.once('close', () =>
      this.usage.count(principal.id, route, new Date(), quota === null),
    );
    return next.handle();
  }
}
