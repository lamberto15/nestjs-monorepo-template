import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { at } from '../../core/database/columns.js';

/**
 * The request each outgoing webhook delivery last sent: its headers
 * (`webhook-id`, `webhook-timestamp`, `webhook-signature`, the content type
 * and user agent; never a secret) and when. Written by the recording
 * transport (recording.transport.ts) before each attempt, one row per
 * delivery (the latest attempt replaces the one before), read with the
 * delivery (`GET …/webhook-deliveries/{id}`).
 *
 * Custom: @nestjs/webhooks keeps every attempt's status, duration and
 * response, but not the request it sent. A global table (no `tenant_id`):
 * the worker writes outside any tenant, and the delivery it belongs to is
 * found through the package's tenant-scoped `get()` first.
 */
export const webhookDeliveryRequests = pgTable('webhook_delivery_requests', {
  /** The package's delivery id (`dlv_…`). */
  deliveryId: text('delivery_id').primaryKey(),
  /** 1-based, within the delivery's round (a manual retry starts at 1 again). */
  attempt: integer('attempt').notNull(),
  headers: jsonb('headers').$type<Record<string, string>>().notNull(),
  sentAt: at('sent_at').notNull().defaultNow(),
});
