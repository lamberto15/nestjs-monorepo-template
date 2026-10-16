import { randomUUID } from 'node:crypto';
import {
  ConsoleLogger,
  Injectable,
  Logger,
  type LogLevel,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const LEVELS: LogLevel[] = [
  'verbose',
  'debug',
  'log',
  'warn',
  'error',
  'fatal',
];

/**
 * The application's logger: Nest's ConsoleLogger, one JSON object per line
 * in production (`LOG_FORMAT=json`), readable text in development. Structured
 * params (`logger.log('Paid', { orderId })`) stay fields of the entry. Logs
 * go to stdout: Docker collects them.
 */
export function createLogger(env: NodeJS.ProcessEnv = process.env) {
  const json =
    (env.LOG_FORMAT || (env.NODE_ENV === 'production' ? 'json' : 'text')) ===
    'json';
  const lowest = LEVELS.indexOf((env.LOG_LEVEL || 'log') as LogLevel);
  return new ConsoleLogger({
    json,
    logLevels: LEVELS.slice(Math.max(lowest, 0)),
  });
}

/** A request id we accept from the proxy or the client; anything else is replaced. */
export const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Gives the request its id (`X-Request-Id`: the proxy's or the client's when
 * it's safe, otherwise a new one) and returns it. Registered with `app.use()`
 * before anything else, so even an error of the body parser carries it.
 */
export function assignRequestId(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers['x-request-id'];
  const requestId =
    typeof header === 'string' && REQUEST_ID.test(header)
      ? header
      : randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

/**
 * Gives each request an id (`X-Request-Id`: the proxy's or the client's, or a
 * new one), returns it in the response, and logs one line per request when
 * it ends: method, route, status, duration, caller and request id.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const header = req.headers['x-request-id'];
    const requestId =
      typeof header === 'string' && REQUEST_ID.test(header)
        ? header
        : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      if (path.startsWith('/health')) {
        return;
      }
      const user = (req as { user?: { kind: string; id: string } | null }).user;
      const fields = {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        ip: req.ip,
        principal: user ? `${user.kind}:${user.id}` : undefined,
      };
      const message = `${req.method} ${path} ${res.statusCode}`;
      // 503 says "overloaded, retry" (database_busy…): a warning, not an error alert.
      if (res.statusCode >= 500 && res.statusCode !== 503) {
        this.logger.error(message, fields);
      } else if (res.statusCode >= 400) {
        this.logger.warn(message, fields);
      } else {
        this.logger.log(message, fields);
      }
    });
    next();
  }
}
