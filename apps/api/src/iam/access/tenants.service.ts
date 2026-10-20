import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, notExists, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../core/database/drizzle.js';
import { pgErrorCode, UNIQUE_VIOLATION } from '../../core/database/errors.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  afterCursor,
  countPage,
  type PageQuery,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import {
  apiClients,
  memberships,
  rolePermissions,
  roles,
  userRoles,
} from '../iam.tables.js';
import { InvitationsService } from './invitations.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { SingleTenant } from './single-tenant.js';
import { ALL, type SeedRole } from './permissions.js';
import { TenantLifecycleRegistry } from './tenant-lifecycle.registry.js';
import { TenantTree } from './tenant-tree.js';

/** The built-in role's key (`roles.key`). */
export const ADMINISTRATOR_ROLE = 'administrator';

/** The built-in role of every tenant: the only one that can't be edited or deleted. */
export const ADMINISTRATOR: SeedRole & { system: true } = {
  key: ADMINISTRATOR_ROLE,
  name: 'Administrator',
  description:
    'Everything, including access control. Built in: can’t be changed or deleted.',
  system: true,
  permissions: [ALL],
};

export interface NewTenant {
  name: string;
  /** A short handle (`acme`): lowercase letters, digits and dashes. */
  slug: string;
  /** The deployment's operators (the first start's tenant only). */
  operator?: boolean;
  /** Made by a self sign-up (TENANT_SIGN_UP): the unverified sign-ups' sweep may delete it. */
  createdBySignUp?: boolean;
  /** Its parent in a holding's tenant tree (the operators'; docs/tenancy.md, "The tenant tree"). */
  parentId?: string;
}

/** What an operator may change of a tenant (`PATCH /v1/tenants/{id}`). */
export interface TenantChanges {
  name?: string;
  slug?: string;
  active?: boolean;
  /** Its parent in the tenant tree; null makes it a root. */
  parentId?: string | null;
}

/**
 * 409 `tenant_slug_taken`, on the field (`errors[].path`), so a form shows
 * it under the slug.
 */
export const slugTaken = (slug: string) =>
  new ConflictException({
    code: 'tenant_slug_taken',
    message: `A tenant named "${slug}" exists.`,
    errors: [{ path: 'slug', message: `"${slug}" is taken.` }],
  });

/**
 * Makes tenants (docs/tenancy.md): the row, then, in the new tenant's own
 * scope and in one transaction with it, its roles (Administrator and every
 * declaration's `seedRoles`) and its first administrator's membership. The
 * first start makes the operator tenant through it (AccessSeeder); the
 * operators make the others (`POST /v1/tenants`), and so does a self
 * sign-up with TENANT_SIGN_UP (SignUpTenant).
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly catalog: PermissionCatalog,
    private readonly audit: AuditService,
    private readonly accounts: UsersRepository,
    private readonly invitations: InvitationsService,
    private readonly singleTenant: SingleTenant,
    private readonly lifecycle: TenantLifecycleRegistry,
    private readonly config: ConfigService<IamEnv, true>,
    private readonly tree: TenantTree,
  ) {}

  /**
   * A page of the tenants (the operators' list, `GET /v1/tenants`): newest
   * first unless sorted, filtered by `where` (TENANT_LIST). Global: no
   * tenant's rows, so nothing for row-level security to narrow.
   */
  async page(query: PageQuery, where?: SQL) {
    const db = database(this.txHost);
    const [rows, total] = await Promise.all([
      db
        .select()
        .from(tenants)
        .where(and(where, afterCursor(tenants.id, query)))
        .orderBy(...pageOrder(tenants.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(db, tenants, where, query),
    ]);
    return toPage(rows, query, total);
  }

  /** One tenant, active or not; a 404 when there is none. */
  async get(id: string): Promise<Tenant> {
    const tenant = await this.tenancy.find(id);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    return tenant;
  }

  /**
   * Renames a tenant, changes its slug, or (de)activates it, under the
   * row's lock with the operator's audit entry; then the entry in the
   * tenant itself (its administrators read what the operators did to it),
   * as `createWithAdministrator()` does. The operator tenant is never
   * deactivated (409 `operator_tenant`): the operators would lock
   * themselves out of every operator route, this one included.
   *
   * A deactivated tenant (what `tenants.active` already means: Tenancy,
   * UsersRepository.inTenant, ApiKeyAuthProvider): a session or token
   * acting in it stops (401), its API keys stop, its invitations can't be
   * accepted, a sign-in never starts in it, its jobs and cron runs are
   * skipped. Here, after the commit, as a membership's deactivation does
   * for one member: its sessions and token families end (so reactivating
   * never revives them: its members sign in again) and its realtime
   * connections end (TenantLifecycleRegistry). Nothing else is deleted:
   * reactivating gives back its data, memberships and API keys.
   *
   * `check` (the caller's If-Match) runs under the lock against the tenant
   * as GET /v1/tenants/{id} shows it.
   */
  async update(
    operator: Principal,
    id: string,
    changes: TenantChanges,
    ip?: string,
    check?: (current: Tenant) => void,
  ): Promise<Tenant> {
    const { before, after } = await inTransaction(this.txHost, async (tx) => {
      const [current] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, id))
        .for('update');
      if (!current) {
        throw new NotFoundException(`Tenant ${id} not found.`);
      }
      check?.(current);
      if (current.operator && changes.active === false) {
        throw operatorTenant('deactivated');
      }
      if (current.deletionScheduledFor && changes.active === true) {
        throw deletionPending();
      }
      if (
        changes.parentId !== undefined &&
        changes.parentId !== current.parentId
      ) {
        // The tree first: its closure in this transaction, under the lock.
        await this.tree.place(tx, current, changes.parentId);
      }
      const [updated] = await tx
        .update(tenants)
        .set({
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.slug !== undefined && { slug: changes.slug }),
          ...(changes.active !== undefined && { active: changes.active }),
          // As place() set it (the same value): never an empty change.
          ...(changes.parentId !== undefined && {
            parentId: changes.parentId,
          }),
        })
        .where(eq(tenants.id, id))
        .returning()
        .catch((error: unknown) => {
          if (pgErrorCode(error) === UNIQUE_VIOLATION) {
            throw slugTaken(changes.slug ?? current.slug);
          }
          throw error;
        });
      await this.audit.record(
        operator,
        tenantUpdated(current, updated!, ip),
        tx,
      );
      return { before: current, after: updated! };
    });
    // The tenant's own log too (the operator's tenant has its entry already).
    if (id !== this.tenancy.current()?.tenantId) {
      await this.tenancy.run(id, () =>
        this.audit.record(operator, tenantUpdated(before, after, ip)),
      );
    }
    if (before.active && !after.active) {
      await this.accounts.endAllTenantSessions(id);
      await this.afterDeactivation(id);
    }
    return after;
  }

  /**
   * Asks for a tenant's deletion (docs/tenancy.md, "Deleting a tenant"):
   * `slug` must be the tenant's (the operator typed what they meant to
   * delete). Under the row's lock, in one transaction with the operator's
   * audit entry: the tenant is deactivated (as `update({ active: false })`
   * does, its sessions, tokens and connections ending after the commit)
   * and its erase scheduled TENANT_DELETION_GRACE_DAYS from now, which
   * TenantDeletionJob carries out in a worker; `cancelDeletion()` stops it
   * until then. Asked again while one is pending: that one, unchanged
   * (nothing scheduled twice). The operator tenant is never deleted (409
   * `operator_tenant`). Audited `tenant.deletion-requested` in the
   * operator's tenant and in that one (its administrators see it coming).
   */
  async requestDeletion(
    operator: Principal,
    id: string,
    slug: string,
    ip?: string,
  ): Promise<Tenant> {
    const days = this.config.get('TENANT_DELETION_GRACE_DAYS', {
      infer: true,
    });
    const outcome = await inTransaction(this.txHost, async (tx) => {
      const current = await this.lockRow(tx, id);
      if (current.operator) {
        throw operatorTenant('deleted');
      }
      if (current.deletionScheduledFor) {
        return { before: current, after: current, requested: false };
      }
      if (await this.tree.hasChildren(tx, id)) {
        throw new ConflictException({
          code: 'tenant_has_children',
          message:
            'The tenant has children in its tenant tree: move them first (PATCH /v1/tenants/{id} { parentId }).',
        });
      }
      if (slug !== current.slug) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: 'Type the tenant’s slug to confirm its deletion.',
          errors: [
            {
              path: 'slug',
              message: `Not this tenant’s slug ("${current.slug}").`,
            },
          ],
        });
      }
      const now = new Date();
      const scheduledFor = new Date(now.getTime() + days * 86_400_000);
      const [updated] = await tx
        .update(tenants)
        .set({
          active: false,
          deletionRequestedAt: now,
          deletionScheduledFor: scheduledFor,
        })
        .where(eq(tenants.id, id))
        .returning();
      await this.audit.record(
        operator,
        deletionEntry('tenant.deletion-requested', updated!, current, ip),
        tx,
      );
      return { before: current, after: updated!, requested: true };
    });
    if (!outcome.requested) {
      return outcome.after;
    }
    if (id !== this.tenancy.current()?.tenantId) {
      await this.tenancy.run(id, () =>
        this.audit.record(
          operator,
          deletionEntry(
            'tenant.deletion-requested',
            outcome.after,
            outcome.before,
            ip,
          ),
        ),
      );
    }
    if (outcome.before.active) {
      await this.accounts.endAllTenantSessions(id);
      await this.afterDeactivation(id);
    }
    return outcome.after;
  }

  /**
   * Cancels a tenant's pending deletion, under the row's lock, until the
   * job starts erasing it (409 `tenant_deletion_started` from then on); a
   * 404 when none is pending. The tenant stays deactivated: an operator
   * reactivates it (`PATCH { active: true }`) when it should come back.
   * Audited `tenant.deletion-cancelled` in both tenants.
   */
  async cancelDeletion(
    operator: Principal,
    id: string,
    ip?: string,
  ): Promise<Tenant> {
    const tenant = await inTransaction(this.txHost, async (tx) => {
      const current = await this.lockRow(tx, id);
      if (!current.deletionScheduledFor) {
        throw new NotFoundException('No deletion is pending for this tenant.');
      }
      if (current.deletionStartedAt) {
        throw new ConflictException({
          code: 'tenant_deletion_started',
          message: 'The tenant is being erased: it can’t be cancelled now.',
        });
      }
      const [updated] = await tx
        .update(tenants)
        .set({
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        })
        .where(eq(tenants.id, id))
        .returning();
      await this.audit.record(
        operator,
        deletionEntry('tenant.deletion-cancelled', current, current, ip),
        tx,
      );
      return { before: current, after: updated! };
    });
    if (id !== this.tenancy.current()?.tenantId) {
      await this.tenancy.run(id, () =>
        this.audit.record(
          operator,
          deletionEntry(
            'tenant.deletion-cancelled',
            tenant.before,
            tenant.before,
            ip,
          ),
        ),
      );
    }
    return tenant.after;
  }

  /** The tenant's row, locked for the transaction; a 404 when there is none. */
  private async lockRow(tx: Transaction, id: string): Promise<Tenant> {
    const [current] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, id))
      .for('update');
    if (!current) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    return current;
  }

  /** Every member and API client of a tenant, active or not (the lifecycle listeners'). */
  async principalsOf(tenantId: string) {
    const members = await database(this.txHost)
      .select({ id: memberships.userId })
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId));
    const clients = await this.tenancy.run(tenantId, async () =>
      database(this.txHost).select({ id: apiClients.id }).from(apiClients),
    );
    return [
      ...members.map(({ id }) => ({ kind: 'user' as const, id })),
      ...clients.map(({ id }) => ({ kind: 'client' as const, id })),
    ];
  }

  /** Ends what lives outside the database (realtime connections): every member's and API client's in the tenant. */
  private async afterDeactivation(tenantId: string) {
    const principals = await this.principalsOf(tenantId);
    for (const listener of this.lifecycle.all()) {
      await listener.afterDeactivation?.(tenantId, principals);
    }
  }

  /**
   * A new tenant with its roles, and `administrator` (an account's id) as
   * its first administrator, all in one transaction run in the new tenant
   * (its id is drawn first, so the transaction starts with it: a
   * transaction's tenant is fixed when it begins). `work` runs last in the
   * same transaction (the first start's audit entry).
   */
  async create<T = void>(
    input: NewTenant,
    administrator: string | null,
    work?: (tx: Transaction, tenant: Tenant) => Promise<T>,
    /** Runs first in the transaction (the first start's lock and check). */
    first?: (tx: Transaction) => Promise<void>,
  ): Promise<{ tenant: Tenant; result: T | undefined }> {
    const id = await this.newId();
    return this.tenancy.run(id, () =>
      inTransaction(this.txHost, async (tx) => {
        await first?.(tx);
        // TENANCY=single: the first start's tenant is the only one.
        await this.singleTenant.assertMayCreate(tx);
        const [tenant] = await tx
          .insert(tenants)
          .values({
            id,
            name: input.name,
            slug: input.slug,
            operator: input.operator ?? false,
            createdBySignUp: input.createdBySignUp ?? false,
          })
          .returning()
          .catch((error: unknown) => {
            if (pgErrorCode(error) === UNIQUE_VIOLATION) {
              throw slugTaken(input.slug);
            }
            throw error;
          });
        const placed = input.parentId
          ? await this.tree.place(tx, tenant!, input.parentId)
          : tenant!;
        await this.seedRoles(tx);
        if (administrator) {
          await this.addAdministrator(tx, administrator);
        }
        const result = work ? await work(tx, placed) : undefined;
        return { tenant: placed, result };
      }),
    );
  }

  /**
   * Makes the account a member of the tenant being created, with the
   * Administrator role, in `create()`'s transaction (in its scope): its
   * first administrator. `create()` does it for the account it is given;
   * the demo seed (src/demo), for the account it makes in that transaction.
   * Nothing else grants Administrator without an administrator's request.
   */
  async addAdministrator(tx: Transaction, userId: string) {
    // A member already (the demo seed's), or one now.
    await this.accounts.joinTenant(tx, this.tenancy.tenantId(), userId);
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, ADMINISTRATOR_ROLE));
    await tx.insert(userRoles).values({ userId, roleId: role!.id });
  }

  /**
   * The operators' way: a tenant whose first administrator is invited at
   * `email` (docs/tenancy.md, "Invitations"): the tenant, its roles, the
   * invitation (the Administrator role) and its audit entry in one
   * transaction, so a refused slug leaves nothing behind; the mail after
   * the commit. Nothing about an account at that address is read or
   * changed: its owner accepts (or, new, chooses a password) with the link.
   * Audited in the new tenant and in the operator's own. The answer is
   * the tenant and its administrator's invitation (`status: 'invited'`).
   */
  async createWithAdministrator(
    operator: Principal,
    input: NewTenant & { administratorEmail: string },
    ip?: string,
  ) {
    const { tenant, result } = await this.create(
      { name: input.name, slug: input.slug, parentId: input.parentId },
      null,
      async (tx, created) => {
        const [administrator] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.key, ADMINISTRATOR_ROLE));
        const invited = await this.invitations.create(
          tx,
          { email: input.administratorEmail, roleIds: [administrator!.id] },
          operator,
        );
        await this.audit.record(
          operator,
          {
            action: 'tenant.created',
            targetType: 'tenant',
            targetId: created.id,
            details: {
              slug: created.slug,
              administrator: invited.invitation.email,
              ...(created.parentId && { parentId: created.parentId }),
            },
            ip,
          },
          tx,
        );
        return invited;
      },
    );
    await this.audit.record(operator, {
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: tenant.id,
      details: {
        slug: tenant.slug,
        administrator: result!.invitation.email,
        ...(tenant.parentId && { parentId: tenant.parentId }),
      },
      ip,
    });
    await this.tenancy.run(tenant.id, () =>
      this.invitations.send(result!.invitation, result!.token, operator),
    );
    // Always invited: whether the address has an account is never read
    // here (the invite-only rule), so the answer can't tell an operator
    // which addresses have one. Its owner's acceptance decides (a new
    // account chooses its password, an existing one accepts signed in).
    return {
      ...tenant,
      administrator: {
        email: result!.invitation.email,
        status: 'invited' as const,
        expiresAt: result!.invitation.expiresAt,
      },
    };
  }

  /**
   * Deletes a tenant's row, in the caller's transaction: the database
   * cascades to its tenant rows and its memberships (every `tenant_id` key
   * is `on delete cascade`; referential actions run past row-level
   * security). Nothing outside the database (stored files, queued jobs,
   * workflows): TenantDeletionJob removes those first (the lifecycle
   * listeners' `beforeErase`); the unverified sign-ups' sweep calls it
   * alone, for tenants whose members never signed in, so never had any.
   * Never the operator tenant, nor a tenant with children in the tenant
   * tree (their `parent_id` would dangle: `restrict`): undefined then.
   */
  async deleteRow(tx: Transaction, id: string): Promise<Tenant | undefined> {
    const child = alias(tenants, 'child');
    const [deleted] = await tx
      .delete(tenants)
      .where(
        and(
          eq(tenants.id, id),
          eq(tenants.operator, false),
          notExists(
            tx
              .select({ id: child.id })
              .from(child)
              .where(eq(child.parentId, tenants.id)),
          ),
        ),
      )
      .returning();
    return deleted;
  }

  /** The tenant's roles: the built-in Administrator and the declarations' `seedRoles`. */
  private async seedRoles(tx: Transaction) {
    for (const role of [ADMINISTRATOR, ...this.catalog.seedRoles]) {
      const [row] = await tx
        .insert(roles)
        .values({
          key: role.key,
          name: role.name,
          description: role.description,
          system: 'system' in role,
        })
        .returning({ id: roles.id });
      if (role.permissions.length > 0) {
        await tx.insert(rolePermissions).values(
          role.permissions.map((permission) => ({
            roleId: row!.id,
            ...permission,
          })),
        );
      }
    }
  }

  /** A time-ordered id from PostgreSQL, as every row's (uuidv7()). */
  private async newId() {
    const result = await database(this.txHost).execute<{ id: string }>(
      sql`select uuidv7() as id`,
    );
    return (result as unknown as { rows: { id: string }[] }).rows[0]!.id;
  }
}

/** 409 `tenant_deletion_pending`: reactivating a tenant whose erase is scheduled. */
const deletionPending = () =>
  new ConflictException({
    code: 'tenant_deletion_pending',
    message:
      'The tenant’s deletion is pending: cancel it (DELETE /v1/tenants/{id}/deletion) before reactivating it.',
  });

/** 409 `operator_tenant`: the operators' own tenant is never deactivated nor deleted. */
const operatorTenant = (what: 'deactivated' | 'deleted') =>
  new ConflictException({
    code: 'operator_tenant',
    message: `The operator tenant can’t be ${what}: its members run the deployment.`,
  });

/** The audit entry of a deletion's request or cancel. */
function deletionEntry(
  action: string,
  tenant: Tenant,
  before: Tenant,
  ip?: string,
) {
  return {
    action,
    targetType: 'tenant',
    targetId: tenant.id,
    details: {
      slug: tenant.slug,
      ...(tenant.deletionScheduledFor && {
        scheduledFor: tenant.deletionScheduledFor.toISOString(),
      }),
      ...(action === 'tenant.deletion-requested' && {
        deactivated: before.active,
      }),
    },
    ip,
  };
}

/** The audit entry of a tenant's change: what changed, from → to. */
function tenantUpdated(before: Tenant, after: Tenant, ip?: string) {
  const changed = (['name', 'slug', 'active', 'parentId'] as const).filter(
    (field) => before[field] !== after[field],
  );
  return {
    action: 'tenant.updated',
    targetType: 'tenant',
    targetId: after.id,
    details: {
      slug: after.slug,
      ...Object.fromEntries(
        changed.map((field) => [
          field,
          { from: before[field], to: after[field] },
        ]),
      ),
    },
    ip,
  };
}
