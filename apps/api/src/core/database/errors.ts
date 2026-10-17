/**
 * PostgreSQL's error code (SQLSTATE) of a failed query: on the error
 * node-postgres throws, or on the `cause` Drizzle wraps it in.
 */
export const pgErrorCode = (error: unknown): string | undefined =>
  (error as { code?: string })?.code ??
  (error as { cause?: { code?: string } })?.cause?.code;

/** A unique index or constraint refused the row: a 409 for the caller, not a 500. */
export const UNIQUE_VIOLATION = '23505';
