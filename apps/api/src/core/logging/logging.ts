import { randomUUID } from 'node:crypto';
import {
  ConsoleLogger,
  type ConsoleLoggerOptions,
  Injectable,
  Logger,
  type LogLevel,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { type LogRedaction, logRedaction } from './redaction.js';

const LEVELS: LogLevel[] = [
  'verbose',
  'debug',
  'log',
  'warn',
  'error',
  'fatal',
];

/**
 * Nest's ConsoleLogger with the secrets kept out (redaction.ts). The
 * logger's own `redact` option masks the declared keys in structured params
 * and logged objects; what it leaves as is (its docs: string messages, the
 * error message, the stack trace) goes through the registry's text
 * patterns here, on the whole line it is about to write, so a credential
 * interpolated into a message, an error's message or a stack never reaches
 * stdout. The hooks are the ones ConsoleLogger exposes for subclasses:
 * `formatMessage` is the text line, `stringifyJsonLogObject` the JSON one,
 * `printStackTrace` the stack text mode writes after an error.
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  constructor(
    options: ConsoleLoggerOptions,
    private readonly redaction: LogRedaction,
  ) {
    super({ ...options, redact: redaction.paths() });
  }

  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    return this.redaction.redactText(
      super.formatMessage(
        logLevel,
        message,
        pidMessage,
        formattedLogLevel,
        contextMessage,
        timestampDiff,
        params,
      ),
    );
  }

  protected override stringifyJsonLogObject(
    logObject: Record<string, unknown>,
  ): string {
    return this.redaction.redactText(super.stringifyJsonLogObject(logObject));
  }

  protected override printStackTrace(stack: string) {
    super.printStackTrace(stack && this.redaction.redactText(stack));
  }
}

/**
 * The application's logger: Nest's ConsoleLogger, one JSON object per line
 * in production (`LOG_FORMAT=json`), readable text in development, with
 * secrets redacted (redaction.ts). Structured params (`logger.log('Paid',
 * { orderId })`) stay fields of the entry. Logs go to stdout: Docker
 * collects them. Building it closes the redaction registry: everything
 * must be declared by then (at import time).
 */
export function createLogger(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ConsoleLoggerOptions> = {},
  redaction: LogRedaction = logRedaction,
) {
  const json =
    (env.LOG_FORMAT || (env.NODE_ENV === 'production' ? 'json' : 'text')) ===
    'json';
  const lowest = LEVELS.indexOf((env.LOG_LEVEL || 'log') as LogLevel);
  const logger = new RedactingConsoleLogger(
    {
      json,
      logLevels: LEVELS.slice(Math.max(lowest, 0)),
      ...overrides,
    },
    redaction,
  );
  redaction.freeze('createLogger()');
  return logger;
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
