import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * Who watches which record: a subscriber (a principal key) and a record
 * (its permission subject and id). Features notify the watchers of a
 * record when it changes (`SubscriptionsService.notifyWatchers`).
 */
export const recordSubscriptions = pgTable(
  'record_subscriptions',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: text('record_id').notNull(),
    /** `user:<id>` or `client:<id>`. */
    subscriber: text('subscriber').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('record_subscriptions_record_subscriber_idx').on(
      table.tenantId,
      table.subject,
      table.recordId,
      table.subscriber,
    ),
    // One subscriber's watch list in id order (GET /subscriptions), and erase().
    index('record_subscriptions_subscriber_id_idx').on(
      table.subscriber,
      table.id,
    ),
    ...tenantTable('record_subscriptions', table),
  ],
).enableRLS();
