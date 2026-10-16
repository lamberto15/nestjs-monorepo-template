import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';

/**
 * The suppression list: addresses mail is not sent to (docs/deliverability.md).
 * One row per normalized address. `suppressedAt` null: the address is only
 * being watched (soft bounces under MAIL_SOFT_BOUNCE_THRESHOLD); set, the
 * sender leaves it out, with `reason` saying why. `events` counts the
 * provider's bounces and complaints for it, `softBounces` the transient
 * ones in a row (a delivery resets it). `skipped` counts the mails kept
 * from it since.
 */
export const mailSuppressions = pgTable(
  'mail_suppressions',
  {
    id: uuidPk(),
    address: text('address').notNull(),
    /** hard_bounce, soft_bounce, complaint, manual (core/mail/mail-suppression.ts). */
    reason: text('reason').notNull(),
    /** The provider that reported it (`ses`), or `manual`. */
    source: text('source').notNull(),
    /** An administrator's note on a manual entry. */
    note: text('note'),
    /** The provider's last word on it (a bounce sub-type, a diagnostic code), shortened. */
    lastDetail: text('last_detail'),
    events: integer('events').notNull().default(0),
    softBounces: integer('soft_bounces').notNull().default(0),
    firstSeenAt: at('first_seen_at').notNull().defaultNow(),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
    suppressedAt: at('suppressed_at'),
    skipped: integer('skipped').notNull().default(0),
    lastSkippedAt: at('last_skipped_at'),
    /** `user:<id>` for a manual entry, `system:mail-intake` for the provider's. */
    createdBy: text('created_by'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('mail_suppressions_address_idx').on(table.address),
    index('mail_suppressions_reason_idx').on(table.reason),
    index('mail_suppressions_suppressed_at_idx').on(table.suppressedAt),
    index('mail_suppressions_last_seen_at_idx').on(table.lastSeenAt),
  ],
);

/**
 * Every bounce, complaint and delivery a provider reported, one row per
 * message and recipient: the replay protection (a redelivered notification
 * changes nothing) and the trail behind each suppression. Kept
 * MAIL_EVENTS_RETENTION_DAYS. A log table: rows are added, never edited.
 */
export const mailEvents = pgTable(
  'mail_events',
  {
    id: uuidPk(),
    /** The intake that received it: `ses`. */
    provider: text('provider').notNull(),
    /** The provider's id for the notification (SNS MessageId). */
    eventId: text('event_id').notNull(),
    /** hard_bounce, soft_bounce, complaint, delivery. */
    type: text('type').notNull(),
    address: text('address').notNull(),
    occurredAt: at('occurred_at').notNull(),
    detail: text('detail'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mail_events_provider_event_address_idx').on(
      table.provider,
      table.eventId,
      table.address,
    ),
    index('mail_events_address_idx').on(table.address),
    index('mail_events_created_at_idx').on(table.createdAt),
  ],
);
