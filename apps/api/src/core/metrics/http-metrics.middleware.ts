import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { matchedRouteKey } from '../http/route-key.js';
import { MetricsService } from './metrics.service.js';

/** Not measured: the scrape itself and the health checks (polled every few seconds). */
const UNMEASURED = /^\/(metrics|health)(\/|\?|$)/;

/**
 * Times every request from its start to the response's `close` (also when
 * the caller hangs up), labelled by the matched route pattern, read at the
 * end since routing comes after middleware: `GET /v1/notes/{id}`, never the
 * URL, so ids don't make one series each. No route matched: `unmatched`.
 *
 * A middleware, not an interceptor: interceptors don't see requests that
 * guards, pipes or a 404 stop first.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    if (UNMEASURED.test(req.originalUrl)) {
      return next();
    }
    this.metrics.inFlight.inc();
    const end = this.metrics.httpDuration.startTimer();
    res.once('close', () => {
      this.metrics.inFlight.dec();
      end({
        method: req.method,
        route: matchedRouteKey(req) ?? 'unmatched',
        status: String(res.statusCode),
      });
    });
    next();
  }
}
