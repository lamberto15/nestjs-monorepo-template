import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../database/columns.js';

/**
 * A tenant's limits (docs/tenancy.md, "Quotas"). Each is a whole number;
 * absent: the deployment's default. `maxRecords` is per feature, by the
 * record's permission subject (`Note`).
 */
export interface TenantQuotaLimits {
  maxMembers?: number;
  maxApiClients?: number;
  maxStorageBytes?: number;
  maxRecords?: Record<string, number>;
}

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
export const tenants = pgTable(
  'tenants',
  {
    id: uuidPk(),
    /** A short handle in URLs and logs (`acme`), unique. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** Immutable local-storage object key for the current branding logo. */
    logoKey: text('logo_key'),
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
    /**
     * The tenant above it in a holding's tree (docs/tenancy.md, "The tenant
     * tree"); null: a root. Set by the operators only (`PATCH /v1/tenants/{id}
     * { parentId }`), with `tenant_closure` in the same transaction. A
     * tenant with children isn't deleted (`restrict`): detach them first.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => tenants.id, {
      onDelete: 'restrict',
    }),
    /**
     * The limits the operators set for this tenant (`PUT /v1/tenants/{id}/quotas`,
     * core/tenancy/tenant-quotas.ts); an absent key falls back to the
     * deployment's default (the `quotas.*` platform settings), which is
     * unlimited until an operator sets one.
     */
    quotas: jsonb('quotas').$type<TenantQuotaLimits>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    index('tenants_parent_id_idx').on(t.parentId),
    check('tenants_parent_not_self', sql`${t.parentId} <> ${t.id}`),
  ],
);

export type Tenant = typeof tenants.$inferSelect;

/**
 * The tenant tree's closure (docs/tenancy.md, "The tenant tree"): one row
 * per ancestor and descendant at any depth (`depth` 1 is a parent and its
 * child), none for a tenant and itself. Global, as `tenants`: what the
 * read policies of every tenant table ask (`tenantPolicies()`): a read
 * sees a tenant other than `app.tenant_id` only when it is one of that
 * tenant's descendants here, whatever `app.read_tenants` says. Kept by
 * TenantTree in the transaction that moves a tenant, never by hand.
 */
export const tenantClosure = pgTable(
  'tenant_closure',
  {
    ancestorId: uuid('ancestor_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    descendantId: uuid('descendant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ancestorId, t.descendantId] }),
    index('tenant_closure_descendant_idx').on(t.descendantId),
    check('tenant_closure_depth', sql`${t.depth} >= 1`),
    check('tenant_closure_not_self', sql`${t.ancestorId} <> ${t.descendantId}`),
  ],
);
