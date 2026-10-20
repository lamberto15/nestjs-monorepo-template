import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * The senders of a tenant's incoming webhooks (`POST
 * /v1/webhooks/tenants/{tenantId}/senders/{name}`): a name unique per tenant
 * and the secret its calls are signed with (Standard Webhooks). A tenant
 * table: the receiver finds a sender inside the tenant the URL names, so
 * another tenant's sender is out of reach of the row-level security policies.
 *
 * `secret` and `previousSecret` are sealed like the outgoing endpoints'
 * (`WEBHOOKS_ENCRYPTION_KEYS`, incoming-sender-secrets.ts), never returned
 * after creation or rotation and never written to the audit log. After a
 * rotation the previous secret still verifies until `previousSecretExpiresAt`.
 */
export const incomingWebhookSenders = pgTable(
  'incoming_webhook_senders',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The URL segment: lower-case letters, digits and hyphens. */
    name: text('name').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    secret: text('secret').notNull(),
    previousSecret: text('previous_secret'),
    previousSecretExpiresAt: at('previous_secret_expires_at'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('incoming_webhook_senders_name_idx').on(
      table.tenantId,
      table.name,
    ),
    ...tenantTable('incoming_webhook_senders', table),
  ],
).enableRLS();
