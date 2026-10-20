import {
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { normalizers } from '../../core/encryption/data-cipher.js';
import {
  blindIndexText,
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import { users } from '../../iam/iam.tables.js';

/** Where a device receives push messages. */
export const DEVICE_PLATFORMS = ['web', 'ios', 'android'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * A person's device that can receive push messages (docs/notifications.md,
 * "Push and SMS"). Global, like the account it belongs to: a person's
 * devices are theirs in every tenant. Its own lifecycle: it is removed (the row
 * deleted with its token) when the person removes it, the provider reports
 * the token dead, it is not seen for DEVICES_RETENTION_DAYS, or the account
 * is erased, not when a session ends (a web session lasts 12 hours, a
 * device's token much longer). The token is personal data: encrypted, with a
 * blind index to find a re-registered token.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<DevicePlatform>().notNull(),
    /** What the user calls it ("Pixel 9"). */
    name: text('name').notNull(),
    /** The provider's token (web: the subscription as JSON). Encrypted. */
    token: encryptedText('token').notNull(),
    tokenIndex: blindIndexText('token_index').notNull(),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    index('devices_user_id_idx').on(table.userId),
    index('devices_token_index_idx').on(table.tokenIndex),
  ],
);

encrypted(devices.token, {
  blindIndex: devices.tokenIndex,
  normalize: normalizers.exact,
});

/**
 * A user's phone number for SMS: encrypted, with a blind index so an
 * inbound STOP (which names only the number) finds it. One per user. Not
 * used before verified (an SMS code), and not after the number opted out
 * (STOP): only START re-enables it.
 */
export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** E.164, encrypted. */
    phone: encryptedText('phone').notNull(),
    phoneIndex: blindIndexText('phone_index').notNull(),
    verifiedAt: at('verified_at'),
    /** STOP received: no SMS until START. */
    optedOutAt: at('opted_out_at'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('phone_numbers_user_id_idx').on(table.userId),
    index('phone_numbers_phone_index_idx').on(table.phoneIndex),
  ],
);

encrypted(phoneNumbers.phone, {
  blindIndex: phoneNumbers.phoneIndex,
  normalize: normalizers.phone,
});

/**
 * What a tenant sent today, per counter (`tenant`, `prefix:+44`,
 * `user:<id>`), for the toll-fraud caps: incremented before each SMS, so a
 * cap holds under concurrent workers.
 */
export const messagingUsage = pgTable(
  'messaging_usage',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    day: date('day', { mode: 'string' }).notNull(),
    counter: text('counter').notNull(),
    count: integer('count').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('messaging_usage_counter_idx').on(
      table.tenantId,
      table.day,
      table.counter,
    ),
    index('messaging_usage_day_idx').on(table.day),
    ...tenantTable('messaging_usage', table),
  ],
).enableRLS();
