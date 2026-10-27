/**
 * PostgreSQL's error code (SQLSTATE) of a failed query: on the error
 * node-postgres throws, or on the `cause` Drizzle wraps it in.
 */
export const pgErrorCode = (error: unknown): string | undefined =>
  (error as { code?: string })?.code ??
  (error as { cause?: { code?: string } })?.cause?.code;

/** A unique index or constraint refused the row: a 409 for the caller, not a 500. */
export const UNIQUE_VIOLATION = '23505';

/** A foreign key refused the change: a row still refers to the one deleted. */
const FOREIGN_KEY_VIOLATION = '23503';

/** The same refused by an `ON DELETE RESTRICT` key: PostgreSQL's restrict_violation. */
const RESTRICT_VIOLATION = '23001';

/** A delete refused because rows still refer to it, by a NO ACTION or a RESTRICT key. */
export const isStillReferenced = (error: unknown) => {
  const code = pgErrorCode(error);
  return code === FOREIGN_KEY_VIOLATION || code === RESTRICT_VIOLATION;
};
