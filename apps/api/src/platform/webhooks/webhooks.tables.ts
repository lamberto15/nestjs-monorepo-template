import {
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { apiClients } from '../../iam/iam.tables.js';

/** A signing secret as recorded: when it was made (its identifier) and when it stops signing. */
export interface SigningSecret {
  createdAt: number;
  expiresAt: number | null;
}

/**
 * The request each outgoing webhook delivery last sent: its headers
 * (`webhook-id`, `webhook-timestamp`, `webhook-signature`, the content type
 * and user agent; never a secret), which secrets signed it and when. Written by the recording
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
  /**
   * The secrets that signed that attempt, newest first, in the order of the
   * `v1,…` signatures in `webhook-signature`: each one's `createdAt` (its
   * identifier) and `expiresAt` in epoch ms, never the secret. Null: not
   * recorded (a row from before, or the endpoint's secrets changed between
   * signing and recording).
   */
  signedWith: jsonb('signed_with').$type<SigningSecret[]>(),
  sentAt: at('sent_at').notNull().defaultNow(),
});

/**
 * Which records' events an API client's endpoints receive
 * (docs/webhooks-and-realtime.md, "Subscriber scope"): `own`, the default
 * (no row), only the records the client owns; `tenant`, also the records
 * users and other clients of its tenant own, each only when the client may
 * `read` that record, redacted to what it may read (record-webhooks.service.ts).
 * Per client, not per endpoint: the package fans a message out to every
 * subscribed endpoint of its tenant (the client), so all of a client's
 * endpoints see what the client sees. Set by an administrator with
 * `Access.manageClients` and authority over the client; the client's
 * deletion takes it along.
 */
export const webhookClientScopes = pgTable(
  'webhook_client_scopes',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    clientId: uuid('client_id').notNull(),
    scope: text('scope').$type<WebhookScope>().notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('webhook_client_scopes_client_idx').on(
      table.tenantId,
      table.clientId,
    ),
    ...tenantTable('webhook_client_scopes', table),
    tenantReference(
      'webhook_client_scopes_client_fk',
      [table.tenantId, table.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
  ],
).enableRLS();

/** `own`: the client's own records; `tenant`: every record of its tenant it may read. */
export const WEBHOOK_SCOPES = ['own', 'tenant'] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];
