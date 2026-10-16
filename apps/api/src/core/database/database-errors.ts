import { HttpException, HttpStatus } from '@nestjs/common';
import { ProblemDetailsFilter } from '../http/problem-details.filter.js';

/** Requests refused with database_busy since the pool monitor last looked (it resets it). */
export const refusals = { busy: 0 };

/**
 * The database's overload errors as 503 problems with Retry-After, not 500s:
 * the request was fine, the database couldn't serve it in time. Clients and
 * load balancers retry; the logs still show each one (as a warning).
 *
 * - `database_busy`: no free connection within DATABASE_POOL_TIMEOUT_MS
 *   (node-postgres: "timeout exceeded when trying to connect").
 * - `database_timeout`: PostgreSQL cancelled the statement
 *   (DATABASE_STATEMENT_TIMEOUT_MS; SQLSTATE 57014).
 *
 * Drizzle wraps driver errors (DrizzleQueryError, the driver's in `cause`),
 * so the chain is searched.
 */
ProblemDetailsFilter.map(Error, (error) => {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const { message, code } = e as { message?: unknown; code?: unknown };
    if (
      typeof message === 'string' &&
      message.includes('timeout exceeded when trying to connect')
    ) {
      refusals.busy++;
      return overloaded(
        'database_busy',
        'The service is busy: try again shortly.',
        error,
      );
    }
    if (code === '57014') {
      return overloaded(
        'database_timeout',
        'The request took too long: try again, or narrow it (filters, a smaller page).',
        error,
      );
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
});

const overloaded = (code: string, message: string, cause: Error) =>
  new HttpException(
    { message, code, retryAfter: 1 },
    HttpStatus.SERVICE_UNAVAILABLE,
    { cause },
  );
