import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { ErrorTracker } from '../observability/error-tracker.js';
import {
  databaseFailure,
  databaseIncident,
} from '../database/database-observer.js';

/** One field that failed validation. */
export interface ProblemFieldError {
  /** Dotted path in the body or query: `email`, `items.0.quantity`. */
  path: string;
  /** In the request's language. */
  message: string;
}

/**
 * Every error the API answers, as RFC 9457 problem details
 * (`Content-Type: application/problem+json`):
 *
 * ```json
 * { "type": "about:blank", "title": "Bad Request", "status": 400,
 *   "detail": "The request is invalid.", "code": "validation_failed",
 *   "errors": [{ "path": "email", "message": "email must be an email address" }],
 *   "instance": "/v1/auth/sign-in", "requestId": "…" }
 * ```
 *
 * `code` is stable and machine-readable (`validation_failed`, `not_found`,
 * `mfa_required`, `rate_limited`…); `detail` is for people, translated;
 * `requestId` finds the request in the logs. Other fields an exception
 * carries (`retryAfter`…) are kept.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance?: string;
  requestId?: string;
  errors?: ProblemFieldError[];
  [extension: string]: unknown;
}

/** The code of a status, when the exception names none. */
const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  410: 'gone',
  412: 'precondition_failed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'bad_gateway',
  503: 'unavailable',
  504: 'timeout',
};

/** The `code` of a problem whose exception names none: by its status. */
export const problemCode = (status: number) =>
  CODES[status] ?? `http_${status}`;

type ErrorMapper = (error: unknown) => HttpException | undefined;

/**
 * The one exception filter: turns everything thrown into problem details.
 * A group whose packages throw errors of their own (not HttpException)
 * registers how they map: `ProblemDetailsFilter.map(WebhooksError, …)`.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private static readonly mappers: ErrorMapper[] = [];
  private readonly logger = new Logger('Errors');

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    // Absent where the filter is built by hand (tests).
    @Optional() private readonly errorTracker?: ErrorTracker,
  ) {}

  /** How errors of `type` become HTTP errors (return undefined to leave one as a 500). */
  static map<E>(
    type: abstract new (...args: never[]) => E,
    toHttp: (error: E) => HttpException | undefined,
  ) {
    this.mappers.push((error) =>
      error instanceof type ? toHttp(error) : undefined,
    );
  }

  /**
   * What `exception` answers over HTTP: itself, a mapped error, or
   * undefined for a 500. Also for the filters of protocols with their own
   * error body (SCIM's, iam/sso/scim).
   */
  static toHttp(exception: unknown): HttpException | undefined {
    return exception instanceof HttpException
      ? exception
      : (ProblemDetailsFilter.mappers
          .map((mapper) => mapper(exception))
          .find(Boolean) ?? clientError(exception));
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const http = ProblemDetailsFilter.toHttp(exception);

    if (host.getType() === 'ws') {
      // socket.io clients get the same body on their `exception` event.
      const problem = this.problem(http, undefined);
      host
        .switchToWs()
        .getClient<{ emit(event: string, data: unknown): void }>()
        .emit('exception', problem);
      this.log(exception, problem);
      return;
    }
    if (host.getType() !== 'http') {
      throw exception;
    }
    const request = host.switchToHttp().getRequest<{
      originalUrl?: string;
      url?: string;
      headers: Record<string, unknown>;
    }>();
    const response = host.switchToHttp().getResponse();
    const problem = this.problem(http, request);
    this.log(exception, problem);
    const { httpAdapter } = this.adapterHost;
    httpAdapter.setHeader(response, 'Content-Type', 'application/problem+json');
    if (typeof problem.retryAfter === 'number') {
      // A 503 that says when to come back (database_busy): clients and proxies retry.
      httpAdapter.setHeader(
        response,
        'Retry-After',
        String(problem.retryAfter),
      );
    }
    httpAdapter.reply(response, problem, problem.status);
  }

  private problem(
    http: HttpException | undefined,
    request:
      | { originalUrl?: string; url?: string; headers: Record<string, unknown> }
      | undefined,
  ): Problem {
    const status = http?.getStatus() ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const body = http?.getResponse();
    const fields: Record<string, unknown> =
      typeof body === 'object' && body !== null ? { ...body } : {};
    const {
      message,
      error,
      statusCode: _statusCode,
      // The problem's own members: a body's fields of the same name never
      // replace them. @nestjs/terminus answers `{ status: 'error', … }`, which
      // took the place of the 503 and made Express answer 500.
      type: _type,
      title: _title,
      status: _status,
      detail: _detail,
      instance: _instance,
      requestId: _requestId,
      code,
      errorCode,
      errors,
      ...extensions
    } = fields;
    const title = STATUS_CODES[status] ?? 'Error';
    let detail =
      typeof body === 'string'
        ? body
        : typeof message === 'string'
          ? message
          : title;
    let fieldErrors = errors as ProblemFieldError[] | undefined;
    if (Array.isArray(message)) {
      // Nest's own validation errors: a list of messages without paths.
      fieldErrors ??= message.map((text: string) => ({
        path: '',
        message: text,
      }));
      detail = title;
    }
    if (!http) {
      // Never the internals of an unexpected error: the request id finds them in the logs.
      detail = 'Something went wrong on our side.';
    }
    return {
      type: 'about:blank',
      title,
      status,
      detail,
      code:
        typeof code === 'string'
          ? code
          : typeof errorCode === 'string'
            ? errorCode
            : problemCode(status),
      ...extensions,
      // Nest's `error` is the status's name (dropped: `title` says it); an
      // object is data, as terminus' failing indicators on GET /health.
      ...(typeof error === 'object' && error !== null && { error }),
      ...(fieldErrors && { errors: fieldErrors }),
      ...(request && {
        instance: (request.originalUrl ?? request.url ?? '').split('?')[0],
        requestId: safeRequestId(request.headers['x-request-id']),
      }),
    };
  }

  private log(exception: unknown, problem: Problem) {
    if (problem.status === 503 && problem.retryAfter !== undefined) {
      // Overload (database_busy…): a warning, without a stack; the pool monitor says why.
      this.logger.warn(`${problem.instance ?? 'ws'} refused: ${problem.code}`, {
        requestId: problem.requestId,
        code: problem.code,
        ...(databaseFailure(exception) && {
          cancellationReason: databaseFailure(exception)?.reason,
          sqlstate: databaseFailure(exception)?.sqlstate,
          incidentId: databaseIncident(exception)?.incidentId,
        }),
      });
      return;
    }
    if (problem.status >= 500) {
      this.errorTracker?.capture(exception, {
        requestId: problem.requestId,
        code: problem.code,
        status: problem.status,
      });
      this.logger.error(
        `${problem.instance ?? 'ws'} failed: ${(exception as Error)?.message ?? exception}`,
        (exception as Error)?.stack,
        { requestId: problem.requestId, code: problem.code },
      );
    }
  }
}

/** The path of a Standard Schema issue, dotted: `items.0.quantity`. */
const issuePath = (issue: StandardSchemaV1.Issue) =>
  (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? segment.key : segment))
    .map(String)
    .join('.');

/**
 * The validation pipe's errors: one entry per field, with its path and its
 * (translated) message.
 */
export const validationException = (
  issues: readonly StandardSchemaV1.Issue[],
) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors: issues.map((issue) => ({
      path: issuePath(issue),
      message: issue.message,
    })),
  });

/**
 * An error that says it's the client's (an `http-errors` 4xx, as the body
 * parser throws: 413 too large, 415 charset, 400 encoding), as an
 * HttpException with its own message when it's meant to be shown.
 */
function clientError(error: unknown): HttpException | undefined {
  // Only real http-errors (an Error whose status, statusCode and expose agree), not any object.
  if (!(error instanceof Error)) {
    return undefined;
  }
  const { status, statusCode, expose } = error as Error & {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  if (
    typeof status !== 'number' ||
    status !== statusCode ||
    typeof expose !== 'boolean'
  ) {
    return undefined;
  }
  if (status < 400 || status > 499) {
    return undefined;
  }
  // The status's own words: the parser's message names its internals ("entity", limits).
  return new HttpException(STATUS_CODES[status] ?? 'Error', status, {
    cause: error,
  });
}

/** The request id, only when it's one the app could have given (never raw input). */
const safeRequestId = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
    ? value
    : undefined;
