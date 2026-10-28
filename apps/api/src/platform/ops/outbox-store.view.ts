import { bigint, jsonb, pgSchema, text } from 'drizzle-orm/pg-core';

/**
 * The outbox package's messages table (`nest_outbox.messages`, its
 * PostgresOutboxStore's schema version 1), for what the package has no API
 * for: removing a deleted tenant's pending messages (tenant-cleanup.ts) and
 * a recipient's undelivered notification messages (notifications.service.ts),
 * and an operator's scoped backlog recovery (ops-backlog.service.ts).
 *
 * Not in src/schema.ts, so drizzle-kit never generates DDL for it: the
 * package's own migrations own the table (as `nest_webhooks`,
 * webhook-store.view.ts). Only the columns used are declared.
 */
const store = pgSchema('nest_outbox');

export const outboxMessages = store.table('messages', {
  id: text('id').notNull(),
  topic: text('topic').notNull(),
  payload: jsonb('payload'),
  createdAt: bigint('created_at', { mode: 'number' }),
  leaseUntil: bigint('lease_until', { mode: 'number' }),
});

/** Its dead letters (`nest_outbox.dead_letters`): selected by scope, then requeued or purged through `OutboxDeadLetters`. */
export const outboxDeadLetters = store.table('dead_letters', {
  id: text('id').notNull(),
  topic: text('topic').notNull(),
  payload: jsonb('payload'),
  createdAt: bigint('created_at', { mode: 'number' }),
});
