import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { users } from '../../iam/iam.tables.js';

/**
 * A user's request to delete their account: carried out by the nightly
 * job once the grace period passed, unless cancelled before.
 */
export const accountDeletions = pgTable(
  'account_deletions',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedAt: at('requested_at').notNull().defaultNow(),
    /** When the job may carry it out: the request plus ACCOUNT_DELETION_GRACE_DAYS. */
    scheduledFor: at('scheduled_for').notNull(),
    cancelledAt: at('cancelled_at'),
    /** The account was anonymized. */
    completedAt: at('completed_at'),
    ...timestamps(),
  },
  (table) => [
    index('account_deletions_user_id_idx').on(table.userId),
    index('account_deletions_scheduled_for_idx').on(table.scheduledFor),
  ],
);

/** What a user agreed to, and when: a version of the terms, a privacy policy, marketing. Kept as proof. */
export const consents = pgTable(
  'consents',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What was agreed to: `terms`, `privacy`, `marketing`… (the app's own names). */
    kind: text('kind').notNull(),
    /** Which version of it: `2026-01`, `v3`. */
    version: text('version').notNull(),
    acceptedAt: at('accepted_at').notNull().defaultNow(),
    ip: text('ip'),
  },
  (table) => [
    uniqueIndex('consents_user_kind_version_idx').on(
      table.userId,
      table.kind,
      table.version,
    ),
  ],
);
