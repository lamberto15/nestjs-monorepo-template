import {
  bigint,
  pgSequence,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Secrets generated on the first start when their environment variable isn't
 * set, so they stay the same across restarts.
 */
export const appSecrets = pgTable('app_secrets', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
});

/** Distributed locks (@nestjs/locks, DrizzleLockStore): one row per lock key. */
export const locks = pgTable('locks', {
  key: text('key').primaryKey(),
  /** The holder's id; null once released. */
  owner: text('owner'),
  fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
  /** On the database's clock: every instance agrees on it. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Fencing tokens for every key: a sequence never goes back, so they only grow. */
export const locksFencingTokenSeq = pgSequence('locks_fencing_token_seq');
