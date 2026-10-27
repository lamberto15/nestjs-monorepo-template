import { bigint, jsonb, pgSchema } from 'drizzle-orm/pg-core';

/**
 * The outbox package's messages table (`nest_outbox.messages`, its
 * PostgresOutboxStore's schema version 1), for what the package has no API
 * for: removing a deleted tenant's pending messages (tenant-cleanup.ts).
 *
 * Not in src/schema.ts, so drizzle-kit never generates DDL for it: the
 * package's own migrations own the table (as `nest_webhooks`,
 * webhook-store.view.ts). Only the columns used are declared.
 */
const store = pgSchema('nest_outbox');

export const outboxMessages = store.table('messages', {
  payload: jsonb('payload'),
  leaseUntil: bigint('lease_until', { mode: 'number' }),
});
