import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * Millisecond precision, independent of the PostgreSQL session timezone.
 * The UTC conversion makes both date_trunc overloads immutable, so this
 * expression can also back an expression index.
 */
export const utcMilliseconds = (column: AnyColumn | SQL) =>
  sql`date_trunc('milliseconds', ${column} at time zone 'UTC') at time zone 'UTC'`;
