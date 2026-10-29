import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/**
 * A tenant's custom domains (docs/branding.md, "Custom domains"): a
 * hostname the tenant's people reach the app on (`app.acme.com`), proved
 * by a DNS TXT record. Unique per tenant only: a tenant that adds a
 * hostname it does not control blocks nobody (the one that proves it in
 * DNS routes it, `tenant_domain_routes`).
 */
export const tenantDomains = pgTable(
  'tenant_domains',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Lower case, ASCII (an IDN in punycode), no trailing dot, no port. */
    hostname: text('hostname').notNull(),
    /** What the TXT record must hold; published in DNS, so not a secret. */
    verificationToken: text('verification_token').notNull(),
    /** Set while the record resolves; cleared when a check no longer finds it. */
    verifiedAt: at('verified_at'),
    lastCheckedAt: at('last_checked_at'),
    /** Why the last check failed (null once one succeeds). */
    lastError: text('last_error'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('tenant_domains', table),
    uniqueIndex('tenant_domains_tenant_hostname_idx').on(
      table.tenantId,
      table.hostname,
    ),
  ],
).enableRLS();

/**
 * Which tenant a verified hostname routes to: read before there is a
 * tenant (the brand before sign-in, the session's tenant on that host,
 * the TLS `ask` of the edge), so global (core/tenancy/global-tables.ts),
 * as `sso_domain_routes`. One tenant per hostname (the primary key): the
 * first to verify it; the row goes as soon as its domain is removed or a
 * check no longer finds its record. Kept with `tenant_domains` in the
 * same transactions; it holds nothing `tenant_domains` doesn't.
 */
export const tenantDomainRoutes = pgTable(
  'tenant_domain_routes',
  {
    hostname: text('hostname').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [index('tenant_domain_routes_tenant_id_idx').on(table.tenantId)],
);
