import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * Read-only links to one record (the `share` capability, docs/sharing.md):
 * who made it, which of the record's fields (and its files or not) it
 * shows, until when, to whom (a verified address, or anyone holding the
 * link). Only the link's hash is kept: the link itself is shown once, to
 * its maker. A tenant table: the link names its tenant, so it is looked up
 * in that tenant's scope, as an invitation is.
 */
export const recordShares = pgTable(
  'record_shares',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The record's fields the link shows, by name: never a reference to another record. */
    fields: jsonb('fields').$type<string[]>().notNull(),
    /** Whether it lists the record's files and hands out their download links. */
    files: boolean('files').notNull().default(false),
    /** The SHA-256 of the link's token, base64url. */
    tokenHash: text('token_hash').notNull(),
    /** Normalized; set: the link opens only with a code mailed to this address. */
    recipientEmail: text('recipient_email'),
    /** The SHA-256 of the last code mailed to the recipient, its end and the wrong tries at it. */
    codeHash: text('code_hash'),
    codeExpiresAt: at('code_expires_at'),
    codeAttempts: integer('code_attempts').notNull().default(0),
    /** `user:<id>` of who made it: the link shows no more than they still may read. */
    createdBy: text('created_by').notNull(),
    expiresAt: at('expires_at').notNull(),
    revokedAt: at('revoked_at'),
    revokedBy: text('revoked_by'),
    /** How often it was opened, and when last. */
    views: integer('views').notNull().default(0),
    lastViewedAt: at('last_viewed_at'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('record_shares', table),
    uniqueIndex('record_shares_tenant_token_idx').on(
      table.tenantId,
      table.tokenHash,
    ),
    // A record's links (GET /<path>/{id}/shares), and the purge's.
    index('record_shares_record_idx').on(
      table.tenantId,
      table.subject,
      table.recordId,
    ),
  ],
).enableRLS();
