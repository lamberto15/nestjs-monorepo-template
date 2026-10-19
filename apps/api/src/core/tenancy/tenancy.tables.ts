import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../database/columns.js';

/**
 * The customers: each one a contract, a billing and legal boundary, and the
 * hard wall row-level security enforces (docs/tenancy.md). Every tenant
 * table carries a `tenant_id` referencing this one. Users are global
 * (`users`) and belong to tenants through `memberships` (iam); API clients
 * and their keys belong to exactly one tenant. Groups inside a tenant
 * (teams, departments) are roadmap item 25, never tenants of their own.
 *
 * Global, not a tenant table: a user lists the tenants they belong to
 * before choosing one (`GET /v1/auth/tenants`), and a sign-in resolves the
 * session's tenant from it.
 */
export const tenants = pgTable('tenants', {
  id: uuidPk(),
  /** A short handle in URLs and logs (`acme`), unique. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /**
   * Off: nobody acts in it (its sessions and tokens stop, ended by the
   * deactivation; its API keys stop), its jobs are skipped.
   */
  active: boolean('active').notNull().default(true),
  /**
   * The deployment's operators: the tenant the first start seeds. Routes
   * that see every tenant's data (the ops API, the mail suppression list)
   * answer only in it (`@OperatorOnly()`); roadmap 1b replaces this with
   * the platform's super tenant.
   */
  operator: boolean('operator').notNull().default(false),
  ...timestamps(),
});

export type Tenant = typeof tenants.$inferSelect;
