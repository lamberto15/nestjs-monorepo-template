import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { UserLifecycleRegistry } from '../auth/user-lifecycle.registry.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  PasswordHasher,
  PasswordResetService,
  SignInService,
} from '@nestjs/authentication';
import {
  type SQL,
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { PageQuery } from '../../core/http/pagination.js';
import {
  isSystemPrincipal,
  type SystemPrincipal,
  type UserPrincipal,
} from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { BreachedPasswordsService } from '../account/breached-passwords.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Transaction } from '../../core/database/drizzle.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  apiClientRoles,
  memberships,
  rolePermissions,
  roles,
  userTeams,
  userRoles,
  users,
} from '../iam.tables.js';
import { ApiClientLifecycleRegistry } from './api-client-lifecycle.registry.js';
import { ApiClientsService } from './api-clients.service.js';
import { InvitationsService } from './invitations.service.js';
import { TeamsService } from './teams.service.js';
import { AccessService } from './access.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { isAll, type PermissionInput } from './permissions.js';

export interface RoleInput {
  name: string;
  description?: string;
  permissions: PermissionInput[];
}

export interface UserInput {
  email: string;
  /** The name a new account starts with (its owner changes it). */
  name?: string;
  roleIds: string[];
  /** When grants end, by role id (temporary access); the others never do. */
  roleExpiresAt?: Record<string, string>;
  /** The teams the user belongs to. */
  teamIds?: string[];
}

/** What an administrator changes of a membership: never the account (its name, its password). */
export interface UserChanges {
  active?: boolean;
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
  teamIds?: string[];
}

export interface ClientInput {
  name: string;
  /** Requests a UTC day; none (or null): no quota. */
  dailyQuota?: number | null;
  /** CIDRs the client's keys may be used from; none (or empty): any address. */
  allowedCidrs?: string[];
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
  /** When the first key stops working (none: never). */
  keyExpiresAt?: string;
}

export interface ClientChanges {
  active?: boolean;
  /** Requests a UTC day; null removes the quota. */
  dailyQuota?: number | null;
  /** Replaces the IP allowlist; empty removes it. */
  allowedCidrs?: string[];
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
}

/**
 * Changes to roles and users, with the rules that keep access control safe:
 *
 * - Nobody grants what they can't do: a permission can be put in a role, and
 *   a role given to someone, only by a user who holds that action
 *   without conditions (administrators hold everything).
 * - The built-in Administrator role can't be edited or deleted, and only an
 *   administrator gives it.
 * - The last active administrator can't be removed, demoted or deactivated,
 *   and nobody deactivates themselves.
 *
 * Every change is audited in its own transaction, and drops the cached
 * abilities, so it applies from the next request.
 */
/** The advisory lock that serializes changes to who is an administrator. */
const ADMINS_LOCK = 7_300_421_020;

/** A role grant still running: no end, or one still to come (an ended one is gone). */
const liveGrant = (grants: typeof userRoles | typeof apiClientRoles) =>
  or(isNull(grants.expiresAt), gt(grants.expiresAt, new Date()));

@Injectable()
export class AccessAdminService {
  private readonly logger = new Logger('AccessAdmin');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly access: AccessService,
    private readonly catalog: PermissionCatalog,
    private readonly audit: AuditService,
    private readonly accounts: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly signInService: SignInService,
    private readonly passwordReset: PasswordResetService,
    private readonly clients: ApiClientsService,
    private readonly teams: TeamsService,
    private readonly breachedPasswords: BreachedPasswordsService,
    private readonly lifecycle: UserLifecycleRegistry,
    private readonly tenancy: Tenancy,
    private readonly invitations: InvitationsService,
    private readonly clientLifecycle: ApiClientLifecycleRegistry,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  // Roles

  async listRoles() {
    return this.roleViews(
      await this.db.select().from(roles).orderBy(asc(roles.name)),
    );
  }

  /** One role of the tenant, as the list shows it (row-level security: another tenant's is a 404). */
  async getRole(id: string) {
    return (await this.roleViews([await this.findRole(id)]))[0]!;
  }

  /** Roles with their permissions and how many hold them (grants still running). */
  private async roleViews(allRoles: (typeof roles.$inferSelect)[]) {
    const ids = allRoles.map((role) => role.id);
    if (!ids.length) {
      return [];
    }
    const [permissions, members] = await Promise.all([
      this.db
        .select()
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, ids)),
      this.db
        .select({ roleId: userRoles.roleId, members: count() })
        .from(userRoles)
        .where(and(inArray(userRoles.roleId, ids), liveGrant(userRoles)))
        .groupBy(userRoles.roleId),
    ]);
    return allRoles.map((role) => ({
      ...role,
      permissions: permissions
        .filter((permission) => permission.roleId === role.id)
        .map(({ subject, action, conditions, fields }) => ({
          subject,
          action,
          conditions,
          ...(fields && { fields }),
        })),
      members: members.find((row) => row.roleId === role.id)?.members ?? 0,
    }));
  }

  async createRole(actor: UserPrincipal, input: RoleInput, ip?: string) {
    const permissions = await this.checkGrant(actor, input.permissions);
    const id = await this.db
      .transaction(async (tx) => {
        const [{ id }] = await tx
          .insert(roles)
          .values({ name: input.name, description: input.description ?? '' })
          .returning({ id: roles.id });
        await this.writePermissions(tx, id, permissions);
        await this.audit.record(
          actor,
          {
            action: 'role.created',
            targetType: 'role',
            targetId: id,
            details: { name: input.name, permissions },
            ip,
          },
          tx,
        );
        return id;
      })
      .catch(rethrowUnique('A role with this name already exists.'));
    this.access.invalidate();
    return { id };
  }

  async updateRole(
    actor: UserPrincipal,
    id: string,
    input: RoleInput,
    ip?: string,
  ) {
    const role = await this.findRole(id);
    if (role.system) {
      throw new ConflictException(
        'The built-in Administrator role can’t be changed.',
      );
    }
    const permissions = await this.checkGrant(actor, input.permissions);
    await this.db
      .transaction(async (tx) => {
        await tx
          .update(roles)
          .set({
            name: input.name,
            description: input.description ?? '',
            updatedAt: new Date(),
          })
          .where(eq(roles.id, id));
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        await this.writePermissions(tx, id, permissions);
        await this.audit.record(
          actor,
          {
            action: 'role.updated',
            targetType: 'role',
            targetId: id,
            details: { name: input.name, permissions },
            ip,
          },
          tx,
        );
      })
      .catch(rethrowUnique('A role with this name already exists.'));
    this.access.invalidate();
  }

  async deleteRole(actor: UserPrincipal, id: string, ip?: string) {
    const role = await this.findRole(id);
    if (role.system) {
      throw new ConflictException(
        'The built-in Administrator role can’t be deleted.',
      );
    }
    // Deleting a role takes its permissions away: the same rule as granting them.
    await this.checkGrant(actor, await this.rolePermissionsOf([id]));
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(roles).where(eq(roles.id, id));
      await this.audit.record(
        actor,
        {
          action: 'role.deleted',
          targetType: 'role',
          targetId: id,
          details: { name: role.name },
          ip,
        },
        tx,
      );
    });
    this.access.invalidate();
  }

  // Users

  /** A page of the tenant's members, with their role ids (grants still running). */
  async listUsers(query: PageQuery, where?: SQL) {
    const page = await this.accounts.page(
      this.tenancy.tenantId(),
      query,
      where,
    );
    return { ...page, items: await this.withGrants(page.items) };
  }

  /** One member of the tenant, as the list shows them; anyone else is a 404. */
  async getUser(id: string) {
    const member = await this.accounts.findMember(this.tenancy.tenantId(), id);
    if (!member) {
      throw new NotFoundException(`User ${id} not found.`);
    }
    return (await this.withGrants([member]))[0]!;
  }

  /** Members with their role grants still running and their teams. */
  private async withGrants<T extends { id: string; tenantId?: unknown }>(
    items: T[],
  ) {
    const ids = items.map((user) => user.id);
    const [assignments, memberships] = ids.length
      ? await Promise.all([
          // An ended grant is gone: never reported, so never echoed back (#114).
          this.db
            .select()
            .from(userRoles)
            .where(and(inArray(userRoles.userId, ids), liveGrant(userRoles))),
          this.db
            .select()
            .from(userTeams)
            .where(inArray(userTeams.userId, ids)),
        ])
      : [[], []];
    // A view's `tenantId` (the principal's, always null here) says nothing in a tenant's list.
    return items.map(({ tenantId: _tenantId, ...user }) => ({
      ...user,
      roleIds: assignments
        .filter((assignment) => assignment.userId === user.id)
        .map((assignment) => assignment.roleId),
      roles: assignments
        .filter((assignment) => assignment.userId === user.id)
        .map(({ roleId, expiresAt }) => ({ roleId, expiresAt })),
      teamIds: memberships
        .filter((membership) => membership.userId === user.id)
        .map((membership) => membership.teamId),
    }));
  }

  /**
   * Invites someone to the tenant (docs/tenancy.md, "Invitations"): the
   * address gets a link; the membership, with these roles and teams, comes
   * when its owner accepts. Nothing about an account is read, changed or
   * returned here, so the answer is the same whether or not the address
   * has one, and no administrator sets anyone's password.
   */
  async createUser(actor: UserPrincipal, input: UserInput, ip?: string) {
    await this.checkRoleGrant(actor, input.roleIds);
    await this.teams.assertExist(input.teamIds ?? []);
    this.checkExpiries(input.roleIds, input.roleExpiresAt);
    const { invitation, token } = await inTransaction(
      this.txHost,
      async (tx) => {
        const created = await this.invitations.create(tx, input, actor);
        await this.audit.record(
          actor,
          {
            action: 'user.invited',
            targetType: 'invitation',
            targetId: created.invitation.id,
            details: {
              email: created.invitation.email,
              roleIds: created.invitation.roleIds,
              ...(input.roleExpiresAt && {
                roleExpiresAt: input.roleExpiresAt,
              }),
            },
            ip,
          },
          tx,
        );
        return created;
      },
    );
    await this.invitations.send(invitation, token, actor);
    return {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Sends a pending invitation again (expired or not): a new link (the old
   * one stops working: only its hash was kept), a new expiry, the same
   * roles, their ends and teams. Resending hands out the roles again, so
   * the grant rule holds as when inviting: the resender must be able to
   * grant every role it carries (one deleted since is left out, as the
   * acceptance does).
   */
  async resendInvitation(actor: UserPrincipal, id: string, ip?: string) {
    const pending = await this.invitations.findPending(id);
    if (!pending) {
      throw new NotFoundException(`Invitation ${id} not found.`);
    }
    const existing = pending.roleIds.length
      ? await this.db
          .select({ id: roles.id })
          .from(roles)
          .where(inArray(roles.id, pending.roleIds))
      : [];
    await this.checkRoleGrant(
      actor,
      existing.map((role) => role.id),
    );
    const { invitation, token } = await inTransaction(
      this.txHost,
      async (tx) => {
        const renewed = await this.invitations.renew(tx, id);
        if (!renewed) {
          // Accepted or withdrawn meanwhile.
          throw new NotFoundException(`Invitation ${id} not found.`);
        }
        await this.audit.record(
          actor,
          {
            action: 'invitation.resent',
            targetType: 'invitation',
            targetId: id,
            details: {
              email: renewed.invitation.email,
              roleIds: renewed.invitation.roleIds,
            },
            ip,
          },
          tx,
        );
        return renewed;
      },
    );
    await this.invitations.send(invitation, token, actor);
    return {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * A member made by a system job, with the password it generated, never
   * by a request: the demo seed's users (src/demo). The same way as the
   * first start's administrator (AccessSeeder): a verified account (the
   * job made the address up, nobody has to prove it), its membership in
   * the current tenant, its roles and teams, and `user.seeded` with the
   * job as the actor, in the caller's transaction. The grant rule holds
   * (the job must hold what the roles give; it never holds `all.manage`),
   * and the password passes the breach check. Refused for anything but a
   * system principal made in code: administrators invite (`createUser()`).
   */
  async seedUser(
    actor: SystemPrincipal,
    tx: Transaction,
    input: {
      email: string;
      name: string;
      password: string;
      roleIds: string[];
      teamIds?: string[];
    },
  ) {
    if (!isSystemPrincipal(actor)) {
      throw new Error('seedUser() is for system jobs only.');
    }
    await this.checkRoleGrant(actor, input.roleIds);
    const teams = input.teamIds ?? [];
    if ((await this.teams.existing(tx, teams)).length !== teams.length) {
      throw new BadRequestException('Unknown team.');
    }
    await this.breachedPasswords.assertNotBreached(input.password, 'password');
    const created = await this.accounts.create(tx, {
      email: input.email,
      name: input.name,
      passwordHash: await this.passwordHasher.hash(input.password),
      emailVerified: true,
    });
    await this.accounts.addMembership(tx, this.tenancy.tenantId(), created.id);
    await this.writeRoles(tx, userRoles, created.id, input.roleIds);
    await this.teams.setUserTeams(tx, created.id, teams);
    await this.audit.record(
      actor,
      {
        action: 'user.seeded',
        targetType: 'user',
        targetId: created.id,
        details: { email: created.email, roleIds: input.roleIds },
      },
      tx,
    );
    this.access.invalidate();
    return created;
  }

  async updateUser(
    actor: UserPrincipal,
    id: string,
    changes: UserChanges,
    ip?: string,
  ) {
    const tenantId = this.tenancy.tenantId();
    const before = await this.accounts.findMember(tenantId, id);
    if (!before) {
      throw new NotFoundException(`User ${id} not found.`);
    }
    if (changes.active === false && id === actor.id) {
      throw new ConflictException('You can’t deactivate yourself.');
    }
    const current = await this.liveGrantsOf('user', id);
    const currentRoleIds = [...current.keys()];
    if (id !== actor.id) {
      await this.assertAuthorityOver(
        actor,
        await this.permissionsOfHolder('user', id),
        before.email,
      );
    } else if (changes.teamIds) {
      throw new ForbiddenException('You can’t change your own teams.');
    }
    // On oneself too: every role given (an ended one sent back included),
    // taken away or with a moved end goes through the grant rule.
    const grants =
      changes.roleIds &&
      this.regrant(current, changes.roleIds, changes.roleExpiresAt);
    if (grants) {
      await this.checkRoleGrant(actor, grants.changed);
    }
    await inTransaction(this.txHost, async (tx) => {
      // An invitation's acceptance waits (or ran first): one change to the
      // membership at a time.
      await this.accounts.lockMembership(tx, tenantId, id);
      if (changes.active !== undefined) {
        // The membership, not the account: access to this tenant alone.
        await this.accounts.setMembershipActive(
          tx,
          tenantId,
          id,
          changes.active,
        );
        // An account its identity provider's deprovisioning deactivated
        // (no active membership was left) comes back with this one.
        if (
          changes.active &&
          (await this.accounts.reactivateDeprovisioned(tx, id))
        ) {
          await this.audit.record(
            actor,
            {
              action: 'user.account-reactivated',
              targetType: 'user',
              targetId: id,
              details: { email: before.email, reason: 'membership' },
              ip,
            },
            tx,
          );
        }
      }
      if (changes.roleIds && grants) {
        // Ended grants not given again are deleted here, never rewritten.
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await this.writeRoles(
          tx,
          userRoles,
          id,
          changes.roleIds,
          grants.expiries,
        );
      }
      if (changes.teamIds) {
        await this.teams.setUserTeams(tx, id, changes.teamIds);
      }
      await this.assertAnAdministratorRemains(tx);
      if (changes.active === false && before.active) {
        // What waits on them (approvals, delegations) moves on, in this transaction.
        for (const listener of this.lifecycle.all()) {
          await listener.deactivated?.(tx, id, actor);
        }
      }
      await this.audit.record(
        actor,
        {
          action: 'user.updated',
          targetType: 'user',
          targetId: id,
          details: {
            email: before.email,
            ...(changes.active !== undefined && { active: changes.active }),
            ...(changes.roleIds !== undefined && {
              roleIds: { from: currentRoleIds, to: changes.roleIds },
              ...(changes.roleExpiresAt && {
                roleExpiresAt: changes.roleExpiresAt,
              }),
            }),
            ...(changes.teamIds && { teamIds: changes.teamIds }),
          },
          ip,
        },
        tx,
      );
    });
    // A deactivation ends its sessions and tokens in this tenant (the
    // others go on; the membership check would refuse them on their next
    // request anyway).
    if (changes.active === false) {
      await this.accounts.endTenantSessions(id, tenantId);
      if (before.active) {
        for (const listener of this.lifecycle.all()) {
          await listener.afterDeactivation?.(id, tenantId);
        }
      }
    }
    this.access.invalidate();
  }

  // Rules

  /**
   * You may act on someone (their password, activation, roles, teams, keys;
   * or act as them) only if you hold, without conditions, every permission
   * they hold: nobody gains rights through another account.
   */
  async assertAuthorityOver(
    actor: UserPrincipal,
    permissions: PermissionInput[],
    who: string,
  ) {
    try {
      await this.checkGrant(actor, permissions);
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      ) {
        throw new ForbiddenException({
          code: 'authority_required',
          message: `You can’t act on ${who}: they hold permissions you don’t.`,
        });
      }
      throw error;
    }
  }

  /** What a user's or a client's role grants give (ended ones too: the stricter answer). */
  async permissionsOfHolder(kind: 'user' | 'client', id: string) {
    const rows =
      kind === 'user'
        ? await this.db
            .select({ roleId: userRoles.roleId })
            .from(userRoles)
            .where(eq(userRoles.userId, id))
        : await this.db
            .select({ roleId: apiClientRoles.roleId })
            .from(apiClientRoles)
            .where(eq(apiClientRoles.clientId, id));
    return this.rolePermissionsOf(rows.map((row) => row.roleId));
  }

  /** Validates the permissions against the catalog, and checks the actor may grant each. */
  private async checkGrant(
    actor: UserPrincipal | SystemPrincipal,
    permissions: PermissionInput[],
  ) {
    const actorPermissions = await this.access.permissions(actor);
    const isAdmin = actorPermissions.some(isAll);
    const valid: PermissionInput[] = [];
    for (const permission of permissions) {
      if (isAll(permission)) {
        if (!isAdmin) {
          throw new ForbiddenException(
            'Only an administrator grants everything.',
          );
        }
        valid.push(permission);
        continue;
      }
      const result = this.catalog.validate(permission);
      if (!result.ok) {
        throw new BadRequestException(result.error);
      }
      const granted = result.value.fields;
      const holds =
        isAdmin ||
        actorPermissions.some(
          (own) =>
            own.subject === permission.subject &&
            own.action === permission.action &&
            own.conditions.length === 0 &&
            // Your own permission covers the fields: all of them, or these.
            (!own.fields ||
              (!!granted &&
                granted.every((field) => own.fields!.includes(field)))),
        );
      if (!holds) {
        throw new ForbiddenException(
          `You can’t grant ${permission.subject}.${permission.action}${granted ? ` on ${granted.join(', ')}` : ''}: you don’t hold it without conditions.`,
        );
      }
      valid.push(result.value);
    }
    return valid;
  }

  /**
   * The roles exist in this tenant (400 otherwise) and the actor may grant
   * each (403). Also SSO's (iam/sso): who maps an IdP group to a role must
   * be able to grant it, or the mapping would hand it out for them.
   */
  async checkRoleGrant(
    actor: UserPrincipal | SystemPrincipal,
    roleIds: string[],
  ) {
    if (!roleIds.length) {
      return;
    }
    const found = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.id, roleIds));
    if (found.length !== new Set(roleIds).size) {
      throw new BadRequestException('Unknown role.');
    }
    await this.checkGrant(actor, await this.rolePermissionsOf(roleIds));
  }

  /** Also SCIM's (iam/sso/scim): a deprovisioning never leaves the tenant without one. */
  async assertAnAdministratorRemains(tx: Transaction) {
    // One at a time: two admins demoting each other at once can't both see "one left".
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMINS_LOCK})`);
    // In this tenant (row-level security on the roles): its active members.
    const [{ admins }] = await tx
      .select({ admins: count() })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, userRoles.tenantId),
          eq(memberships.userId, userRoles.userId),
        ),
      )
      .where(
        and(
          eq(roles.system, true),
          eq(users.active, true),
          eq(memberships.active, true),
          // A grant that ends later still counts; one that ended doesn't.
          or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, new Date())),
        ),
      );
    if (admins === 0) {
      throw new ConflictException(
        'At least one active administrator must remain.',
      );
    }
  }

  private async rolePermissionsOf(
    roleIds: string[],
  ): Promise<PermissionInput[]> {
    return this.db
      .select({
        subject: rolePermissions.subject,
        action: rolePermissions.action,
        conditions: rolePermissions.conditions,
      })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));
  }

  /**
   * A user's or a client's grants still running: role id → end (null:
   * never). An ended grant isn't current (#114): sent back in `roleIds`, it
   * is given anew, under the grant rule, never revived as it was.
   */
  private async liveGrantsOf(kind: 'user' | 'client', holderId: string) {
    const rows =
      kind === 'user'
        ? await this.db
            .select({
              roleId: userRoles.roleId,
              expiresAt: userRoles.expiresAt,
            })
            .from(userRoles)
            .where(and(eq(userRoles.userId, holderId), liveGrant(userRoles)))
        : await this.db
            .select({
              roleId: apiClientRoles.roleId,
              expiresAt: apiClientRoles.expiresAt,
            })
            .from(apiClientRoles)
            .where(
              and(
                eq(apiClientRoles.clientId, holderId),
                liveGrant(apiClientRoles),
              ),
            );
    return new Map(rows.map((row) => [row.roleId, row.expiresAt]));
  }

  /**
   * What replacing a holder's roles with `roleIds` does to its live grants:
   * each role's end (`roleExpiresAt` when sent, else each kept grant keeps
   * its own; none: never), and the roles whose grant changes, which the
   * actor must be able to grant (checkRoleGrant): given (an ended grant sent
   * back included), taken away, or kept with an end that moves (a later or
   * no end gives more; an earlier one takes away).
   */
  private regrant(
    current: Map<string, Date | null>,
    roleIds: string[],
    roleExpiresAt?: Record<string, string>,
  ) {
    this.checkExpiries(roleIds, roleExpiresAt);
    const expiries =
      roleExpiresAt ??
      Object.fromEntries(
        roleIds.flatMap((roleId) => {
          const end = current.get(roleId);
          return end ? [[roleId, end.toISOString()]] : [];
        }),
      );
    const endOf = (roleId: string) =>
      expiries[roleId] ? Date.parse(expiries[roleId]) : null;
    const changed = [
      ...[...new Set(roleIds)].filter(
        (roleId) =>
          !current.has(roleId) ||
          (current.get(roleId)?.getTime() ?? null) !== endOf(roleId),
      ),
      ...[...current.keys()].filter((roleId) => !roleIds.includes(roleId)),
    ];
    return { changed, expiries };
  }

  private async findRole(id: string) {
    const [role] = await this.db.select().from(roles).where(eq(roles.id, id));
    if (!role) {
      throw new NotFoundException(`Role ${id} not found.`);
    }
    return role;
  }

  private async writePermissions(
    tx: Transaction,
    roleId: string,
    permissions: PermissionInput[],
  ) {
    if (permissions.length) {
      await tx.insert(rolePermissions).values(
        permissions.map((permission) => ({
          roleId,
          ...permission,
        })),
      );
    }
  }

  /** Each grant's end names one of the roles, and is still to come. */
  private checkExpiries(
    roleIds: string[],
    expiresAt: Record<string, string> = {},
  ) {
    const now = Date.now();
    for (const [roleId, when] of Object.entries(expiresAt)) {
      if (!roleIds.includes(roleId)) {
        throw new BadRequestException(
          `roleExpiresAt names ${roleId}, which isn't in roleIds.`,
        );
      }
      if (Date.parse(when) <= now) {
        throw new BadRequestException(
          `The grant of ${roleId} would already have ended.`,
        );
      }
    }
  }

  /**
   * A user's or a client's role grants, each with its end (none: never;
   * the caller checked the ends, checkExpiries). A kept end that passed
   * meanwhile isn't written: an ended grant is gone.
   */
  private async writeRoles(
    tx: Transaction,
    grants: typeof userRoles | typeof apiClientRoles,
    holderId: string,
    roleIds: string[],
    expiresAt: Record<string, string> = {},
  ) {
    const now = Date.now();
    const end = (roleId: string) =>
      expiresAt[roleId] ? new Date(expiresAt[roleId]) : null;
    const unique = [...new Set(roleIds)].filter(
      (roleId) => (end(roleId)?.getTime() ?? Infinity) > now,
    );
    if (!unique.length) {
      return;
    }
    if (grants === userRoles) {
      await tx.insert(userRoles).values(
        unique.map((roleId) => ({
          userId: holderId,
          roleId,
          expiresAt: end(roleId),
        })),
      );
    } else {
      await tx.insert(apiClientRoles).values(
        unique.map((roleId) => ({
          clientId: holderId,
          roleId,
          expiresAt: end(roleId),
        })),
      );
    }
  }

  // API clients

  /** A client with its roles and first key (shown this once). */
  async createClient(actor: UserPrincipal, input: ClientInput, ip?: string) {
    await this.checkRoleGrant(actor, input.roleIds ?? []);
    this.checkExpiries(input.roleIds ?? [], input.roleExpiresAt);
    const { client, key } = await inTransaction(this.txHost, async (tx) => {
      // The quota with the client, in its transaction: never a client
      // without the quota it was made with.
      const created = await this.clients.create(tx, actor, input, ip);
      await this.writeRoles(
        tx,
        apiClientRoles,
        created.client.id,
        input.roleIds ?? [],
        input.roleExpiresAt,
      );
      return created;
    });
    this.access.invalidate();
    return { ...(await this.clients.findView(client.id)), key };
  }

  /** One API client of the tenant (never its keys); another tenant's is a 404. */
  async getClient(id: string) {
    return this.clients.findView(id);
  }

  /**
   * Deletes a client for good (revoking is `active: false`, undone by
   * `true`): its keys stop at once, its role grants and usage go with it,
   * then what lives outside the database (its webhook endpoints, its live
   * connections: ApiClientLifecycleRegistry). Only by someone with
   * authority over it, as rotating its key. The audit entry, in the
   * deletion's transaction, keeps its name.
   */
  async deleteClient(actor: UserPrincipal, id: string, ip?: string) {
    const client = await this.clients.findView(id);
    await this.assertAuthorityOver(
      actor,
      await this.permissionsOfHolder('client', id),
      client.name,
    );
    const tenantId = this.tenancy.tenantId();
    await inTransaction(this.txHost, (tx) =>
      this.clients.remove(tx, actor, id, ip),
    );
    this.access.invalidate();
    // Each listener on its own: one that fails doesn't keep the others
    // from cleaning up (the deletion committed; its keys already stop).
    for (const listener of this.clientLifecycle.all()) {
      try {
        await listener.afterDeletion(id, tenantId);
      } catch (error) {
        this.logger.error(
          `API client ${id} deleted, but "${listener.name}" failed to clean up: ${(error as Error).message}`,
        );
      }
    }
  }

  /** A new key for a client you have authority over (see ApiClientsService.rotate). */
  async rotateClient(
    actor: UserPrincipal,
    id: string,
    options: { graceSeconds: number; expiresAt?: string },
    ip?: string,
  ) {
    const client = await this.clients.findView(id);
    await this.assertAuthorityOver(
      actor,
      await this.permissionsOfHolder('client', id),
      client.name,
    );
    return this.clients.rotate(actor, id, options, ip);
  }

  async revokeClientKey(
    actor: UserPrincipal,
    id: string,
    keyId: string,
    ip?: string,
  ) {
    const client = await this.clients.findView(id);
    await this.assertAuthorityOver(
      actor,
      await this.permissionsOfHolder('client', id),
      client.name,
    );
    await this.clients.revokeKey(actor, id, keyId, ip);
  }

  /** Activates or revokes a client, and replaces its roles. */
  async updateClient(
    actor: UserPrincipal,
    id: string,
    changes: ClientChanges,
    ip?: string,
  ) {
    const before = await this.clients.findView(id);
    await this.assertAuthorityOver(
      actor,
      await this.permissionsOfHolder('client', id),
      before.name,
    );
    const current = await this.liveGrantsOf('client', id);
    const grants =
      changes.roleIds &&
      this.regrant(current, changes.roleIds, changes.roleExpiresAt);
    if (grants) {
      await this.checkRoleGrant(actor, grants.changed);
    }
    await inTransaction(this.txHost, async (tx) => {
      if (changes.active !== undefined) {
        await this.clients.setActive(tx, actor, id, changes.active, ip);
      }
      if (changes.dailyQuota !== undefined) {
        await this.clients.setQuota(tx, actor, id, changes.dailyQuota, ip);
      }
      if (changes.allowedCidrs !== undefined) {
        await this.clients.setAllowedCidrs(
          tx,
          actor,
          id,
          changes.allowedCidrs,
          ip,
        );
      }
      if (changes.roleIds && grants) {
        // Ended grants not given again are deleted here, never rewritten.
        await tx.delete(apiClientRoles).where(eq(apiClientRoles.clientId, id));
        await this.writeRoles(
          tx,
          apiClientRoles,
          id,
          changes.roleIds,
          grants.expiries,
        );
        await this.audit.record(
          actor,
          {
            action: 'client.roles-changed',
            targetType: 'client',
            targetId: id,
            details: {
              roleIds: {
                from: [...current.keys()],
                to: changes.roleIds,
              },
              ...(changes.roleExpiresAt && {
                roleExpiresAt: changes.roleExpiresAt,
              }),
            },
            ip,
          },
          tx,
        );
      }
    });
    this.access.invalidate();
    return this.clients.findView(id);
  }
}

/** A unique-constraint violation as a 409 with a message. */
const rethrowUnique = (message: string) => (error: unknown) => {
  const code =
    (error as { code?: string })?.code ??
    (error as { cause?: { code?: string } })?.cause?.code;
  if (code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
};
