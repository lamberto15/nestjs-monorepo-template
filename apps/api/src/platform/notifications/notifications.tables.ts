import { isNull, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  optionalTenantColumn,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import type { DigestMode, PreferenceOverrides } from './notification.types.js';
import type { QuietHours } from './quiet-hours.js';

/**
 * What a recipient was told: the in-app notification, kept until the
 * retention job removes it. The texts are not stored: `type` and `data`
 * render them in the reader's language when they are read.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuidPk(),
    /**
     * The tenant it is about; null for an account's own (security
     * notifications, sent outside any tenant): those are the person's in
     * every tenant (docs/tenancy.md).
     */
    tenantId: optionalTenantColumn(),
    /** Who it's for: `user:<id>` or `client:<id>`. */
    recipient: text('recipient').notNull(),
    /** A declared type: `note.published`. */
    type: text('type').notNull(),
    /** The placeholders of the title and body (`{title}`), and what a client needs to act. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** The collapse key: a new notification with the same key replaces this one, counted up. */
    key: text('key'),
    /** How many notifications this one stands for (collapsed). */
    count: integer('count').notNull().default(1),
    /** Where to go about it: a path of the web app. */
    link: text('link'),
    readAt: at('read_at'),
    /** The channels were served (or the recipient was gone). */
    deliveredAt: at('delivered_at'),
    /** Awaiting a digest mail, and when it is due. */
    digest: text('digest').$type<DigestMode>(),
    digestDueAt: at('digest_due_at'),
    emailedAt: at('emailed_at'),
    ...timestamps(),
  },
  (table) => [
    // The list (newest first) and its cursor.
    index('notifications_recipient_id_idx').on(table.recipient, table.id),
    index('notifications_recipient_type_idx').on(table.recipient, table.type),
    index('notifications_recipient_created_at_idx').on(
      table.recipient,
      table.createdAt,
    ),
    // The unread list (`?read=false`, newest first, its cursor), the unread
    // count, read-all.
    index('notifications_recipient_unread_id_idx')
      .on(table.recipient, table.id)
      .where(isNull(table.readAt)),
    // The ops page's undelivered count: only the rows still to deliver.
    index('notifications_undelivered_idx')
      .on(table.createdAt)
      .where(isNull(table.deliveredAt)),
    // Per tenant, an account's own (no tenant) counting as one more.
    uniqueIndex('notifications_recipient_key_idx')
      .on(
        sql`coalesce(${table.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.recipient,
        table.key,
      )
      .where(sql`key is not null`),
    // The digest job.
    index('notifications_digest_due_at_idx')
      .on(table.digestDueAt)
      .where(sql`digest_due_at is not null`),
    // Retention.
    index('notifications_created_at_idx').on(table.createdAt),
    index('notifications_read_at_idx')
      .on(table.readAt)
      .where(sql`read_at is not null`),
    ...tenantTable('notifications', table, { nullRows: 'everywhere' }),
  ],
).enableRLS();

/**
 * A recipient's notification preferences: only what differs from the
 * types' defaults, `{ [type]: { [channel]: value } }`, so a change to a
 * type's defaults in code applies to everyone who didn't override it.
 * Global: a person's preferences are theirs in every tenant (an API
 * client's key belongs to one tenant anyway).
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuidPk(),
    recipient: text('recipient').notNull(),
    settings: jsonb('settings')
      .$type<PreferenceOverrides>()
      .notNull()
      .default({}),
    /** Push and SMS wait while the clock of the user's time zone is in this window (urgent types go through); null: none. */
    quietHours: jsonb('quiet_hours').$type<QuietHours>(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('notification_preferences_recipient_idx').on(table.recipient),
  ],
);
