import { between, gt, gte, lt, lte } from 'drizzle-orm';
import { bigint, integer, pgSchema, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { listQuery } from '../../core/http/list-query.js';

/**
 * The webhooks package's deliveries table (`nest_webhooks.deliveries`, its
 * PostgresWebhookStore's schema version 1), read-only, for the paged log.
 *
 * Custom: `WebhookDeliveries.list()` pages by offset, newest first, with
 * exact filters only, while the API's lists page by cursor with
 * `listQuery()` (a date range, a sort). Not in src/schema.ts, so
 * drizzle-kit never generates DDL for it: the package's own migrations own
 * the table (platform.module.ts, `migrate`). Only columns the store
 * contract names are read; every write stays the package's.
 */
const store = pgSchema('nest_webhooks');

export const storeDeliveries = store.table('deliveries', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  endpointId: text('endpoint_id').notNull(),
  tenant: text('tenant'),
  type: text('type').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  nextAttemptAt: bigint('next_attempt_at', { mode: 'number' }),
  lastAttemptAt: bigint('last_attempt_at', { mode: 'number' }),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  failureReason: text('failure_reason'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  completedAt: bigint('completed_at', { mode: 'number' }),
});

/**
 * The package's endpoints table (`nest_webhooks.endpoints`), read-only, for
 * the count per API client (GET /v1/access/clients): `tenant` is the
 * client's id (docs/webhooks-and-realtime.md).
 */
export const storeEndpoints = store.table('endpoints', {
  id: text('id').primaryKey(),
  tenant: text('tenant'),
});

/** The delivery columns as the package's `WebhookDelivery` names them (no lease). */
export const deliveryColumns = {
  id: storeDeliveries.id,
  messageId: storeDeliveries.messageId,
  endpointId: storeDeliveries.endpointId,
  tenant: storeDeliveries.tenant,
  type: storeDeliveries.type,
  status: storeDeliveries.status,
  attempts: storeDeliveries.attempts,
  nextAttemptAt: storeDeliveries.nextAttemptAt,
  lastAttemptAt: storeDeliveries.lastAttemptAt,
  lastStatusCode: storeDeliveries.lastStatusCode,
  lastError: storeDeliveries.lastError,
  failureReason: storeDeliveries.failureReason,
  createdAt: storeDeliveries.createdAt,
  completedAt: storeDeliveries.completedAt,
};

/** A time given as ISO 8601, compared with the store's epoch milliseconds. */
const epochMsOf = (value: unknown) => (value as Date).getTime();
const createdAtColumn = storeDeliveries.createdAt;

/**
 * What GET …/webhook-deliveries can be filtered and sorted by. `createdAt`
 * takes ISO 8601 times, as every list's datetimes; the items show it in
 * epoch milliseconds, as the package does. Newest first (ids are
 * `dlv_<UUIDv7>`, which the cursor carries); `?sort=` orders by `type` or
 * `attempts` before that.
 */
export const DELIVERY_LIST = listQuery(
  {
    endpointId: {
      column: storeDeliveries.endpointId,
      type: 'string',
      ops: ['eq', 'in'],
    },
    status: {
      column: storeDeliveries.status,
      type: 'enum',
      values: ['pending', 'succeeded', 'failed'],
      ops: ['eq', 'in'],
    },
    type: {
      column: storeDeliveries.type,
      type: 'string',
      ops: ['eq', 'in', 'startsWith'],
      sortable: true,
    },
    attempts: {
      column: storeDeliveries.attempts,
      type: 'number',
      ops: ['gte', 'lte'],
      sortable: true,
    },
    createdAt: {
      column: createdAtColumn,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      // The column is epoch ms: each operator compares it with the time's ms.
      conditions: {
        gt: (value) => gt(createdAtColumn, epochMsOf(value)),
        gte: (value) => gte(createdAtColumn, epochMsOf(value)),
        lt: (value) => lt(createdAtColumn, epochMsOf(value)),
        lte: (value) => lte(createdAtColumn, epochMsOf(value)),
        between: (value) => {
          const [from, to] = value as [Date, Date];
          return between(createdAtColumn, from.getTime(), to.getTime());
        },
      },
    },
  },
  {
    select: Object.keys(deliveryColumns),
    // The package's ids: `dlv_` and a UUIDv7's 32 hex digits, time-ordered.
    cursorId: z.string().regex(/^dlv_[0-9a-f]{32}$/),
  },
);
