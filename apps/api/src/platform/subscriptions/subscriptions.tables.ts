import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, uuidPk } from '../../core/database/columns.js';

/**
 * Who watches which record: a subscriber (a principal key) and a record
 * (its permission subject and id). Features notify the watchers of a
 * record when it changes (`SubscriptionsService.notifyWatchers`).
 */
export const recordSubscriptions = pgTable(
  'record_subscriptions',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: text('record_id').notNull(),
    /** `user:<id>` or `client:<id>`. */
    subscriber: text('subscriber').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('record_subscriptions_record_subscriber_idx').on(
      table.subject,
      table.recordId,
      table.subscriber,
    ),
    index('record_subscriptions_subscriber_idx').on(
      table.subscriber,
      table.createdAt,
    ),
  ],
);
