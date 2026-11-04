import { sql } from 'drizzle-orm';
import { text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** An entity's primary key: a UUIDv7 (time-ordered) from PostgreSQL 18's uuidv7(). */
export const uuidPk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

/**
 * A point in time: timestamptz to the millisecond, read as a Date (UTC in
 * the API). A JavaScript Date holds milliseconds, so a value the API hands
 * out (a list cursor, a filter bound) compares equal to the stored one and
 * a keyset can seek the plain column's index.
 */
export const at = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

/**
 * When a record was created and last changed, for every entity table:
 * `...timestamps()`. `updated_at` is set by Drizzle on every update
 * (`$onUpdate`), so writes don't have to remember it. Link and log tables
 * (rows added and removed, never edited) don't need it.
 */
export const timestamps = () => ({
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * For a soft-deletable table (a recycle bin): when and by whom (`user:<id>`,
 * `client:<id>`) a record was deleted; null while it's live. Declare
 * `softDelete` on its resource too (iam/resources/resource.ts): lists,
 * counts and permission checks then leave deleted rows out by themselves.
 */
export const softDeletable = () => ({
  deletedAt: at('deleted_at'),
  deletedBy: text('deleted_by'),
});
