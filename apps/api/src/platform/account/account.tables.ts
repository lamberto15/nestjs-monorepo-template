import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
    /**
     * The job began carrying it out (claimed under the account's lock): no
     * cancel from then on, so none lands between one tenant's erasure and
     * the next.
     */
    startedAt: at('started_at'),
    /** The account was anonymized. */
    completedAt: at('completed_at'),
    ...timestamps(),
  },
  (table) => [
    index('account_deletions_user_id_idx').on(table.userId),
    index('account_deletions_scheduled_for_idx').on(table.scheduledFor),
  ],
);

/**
 * What a user agreed to, and when: a version of the terms, a privacy
 * policy, marketing. Kept as proof: one row per acceptance, never
 * overwritten or deleted while the account lives. A withdrawal (GDPR Art.
 * 7(3)) stamps the kind's rows still in force (`withdrawnAt`, its address);
 * accepting again adds a new row. The state of a kind is its latest row.
 */
export const consents = pgTable(
  'consents',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What was agreed to: a declared kind, `terms`, `privacy`, `marketing` (platform/account/consent-kinds.ts). */
    kind: text('kind').notNull(),
    /** Which version of it: `2026-01`, `v3`. */
    version: text('version').notNull(),
    acceptedAt: at('accepted_at').notNull().defaultNow(),
    ip: text('ip'),
    /** The consent was withdrawn: from then on it no longer holds. */
    withdrawnAt: at('withdrawn_at'),
    /** The address the withdrawal came from. */
    withdrawalIp: text('withdrawal_ip'),
  },
  (table) => [
    index('consents_user_kind_accepted_at_idx').on(
      table.userId,
      table.kind,
      table.acceptedAt,
    ),
  ],
);
