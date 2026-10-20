import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../database/columns.js';

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
  /**
   * Made by a self sign-up (TENANT_SIGN_UP), not by the operators: the
   * tenants the unverified sign-ups' sweep may delete (SignUpTenantSweepJob).
   */
  createdBySignUp: boolean('created_by_sign_up').notNull().default(false),
  /**
   * An operator asked for its deletion (`POST /v1/tenants/{id}/deletion`):
   * deactivated then, erased by TenantDeletionJob once
   * `deletionScheduledFor` passed, unless cancelled before. Null: none
   * pending.
   */
  deletionRequestedAt: at('deletion_requested_at'),
  /** When the erase may run: the request plus TENANT_DELETION_GRACE_DAYS. */
  deletionScheduledFor: at('deletion_scheduled_for'),
  /**
   * The job began erasing it (claimed under the row's lock): no cancel from
   * then on, so none lands between the files' erase and the rows'.
   */
  deletionStartedAt: at('deletion_started_at'),
  ...timestamps(),
});

export type Tenant = typeof tenants.$inferSelect;
