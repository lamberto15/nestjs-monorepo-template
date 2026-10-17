import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
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
import type { UserPrincipal } from '../auth/principal.js';
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
  userOrgUnits,
  userRoles,
  users,
} from '../iam.tables.js';
import { ApiClientsService } from './api-clients.service.js';
import { OrgUnitsService } from './org-units.service.js';
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
  name: string;
  /** Unset: the user is invited by email to set one. */
  password?: string;
  roleIds: string[];
  /** When grants end, by role id (temporary access); the others never do. */
  roleExpiresAt?: Record<string, string>;
  /** The org units the user belongs to. */
  orgUnitIds?: string[];
}

export interface UserChanges {
  name?: string;
  active?: boolean;
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
  orgUnitIds?: string[];
  password?: string;
}

export interface ClientInput {
  name: string;
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
  /** When the first key stops working (none: never). */
  keyExpiresAt?: string;
}

export interface ClientChanges {
  active?: boolean;
  /** Requests a UTC day; null removes the quota. */
  dailyQuota?: number | null;
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

@Injectable()
export class AccessAdminService {
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
    private readonly orgUnits: OrgUnitsService,
    private readonly breachedPasswords: BreachedPasswordsService,
    private readonly lifecycle: UserLifecycleRegistry,
    private readonly tenancy: Tenancy,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  // Roles

  async listRoles() {
    const [allRoles, permissions, members] = await Promise.all([
      this.db.select().from(roles).orderBy(asc(roles.name)),
      this.db.select().from(rolePermissions),
      this.db
        .select({ roleId: userRoles.roleId, members: count() })
        .from(userRoles)
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

  /** A page of the tenant's members, with their role ids. */
  async listUsers(query: PageQuery, where?: SQL) {
    const page = await this.accounts.page(
      this.tenancy.tenantId(),
      query,
      where,
    );
    const ids = page.items.map((user) => user.id);
    const [assignments, memberships] = ids.length
      ? await Promise.all([
          this.db
            .select()
            .from(userRoles)
            .where(inArray(userRoles.userId, ids)),
          this.db
            .select()
            .from(userOrgUnits)
            .where(inArray(userOrgUnits.userId, ids)),
        ])
      : [[], []];
    return {
      ...page,
      items: page.items.map((user) => ({
        ...user,
        roleIds: assignments
          .filter((assignment) => assignment.userId === user.id)
          .map((assignment) => assignment.roleId),
        roles: assignments
          .filter((assignment) => assignment.userId === user.id)
          .map(({ roleId, expiresAt }) => ({ roleId, expiresAt })),
        orgUnitIds: memberships
          .filter((membership) => membership.userId === user.id)
          .map((membership) => membership.orgUnitId),
      })),
    };
  }

  /**
   * Adds someone to the tenant. Users are global (docs/tenancy.md): a new
   * address makes an account (with the password given, or an invitation to
   * choose one); an address that has an account adds that account, with
   * these roles and units, and never touches its credentials, which are its
   * owner's: a password for it is refused (409 `account_exists`). An
   * account nobody claimed yet (its address never proved: another tenant's
   * administrator made it) loses every way in first and gets the invitation,
   * so whoever made it can't follow it here.
   */
  async createUser(actor: UserPrincipal, input: UserInput, ip?: string) {
    const tenantId = this.tenancy.tenantId();
    await this.checkRoleGrant(actor, input.roleIds);
    const existing = await this.accounts.findByEmail(input.email);
    if (existing) {
      return this.addExisting(actor, tenantId, existing, input, ip);
    }
    if (input.password) {
      await this.breachedPasswords.assertNotBreached(
        input.password,
        'password',
      );
    }
    const passwordHash = input.password
      ? await this.passwordHasher.hash(input.password)
      : null;
    const user = await this.db
      .transaction(async (tx) => {
        const created = await this.accounts.create(tx, {
          email: input.email,
          name: input.name,
          passwordHash,
        });
        await this.accounts.addMembership(tx, tenantId, created.id);
        await this.writeRoles(
          tx,
          userRoles,
          created.id,
          input.roleIds,
          input.roleExpiresAt,
        );
        await this.orgUnits.setUserUnits(
          tx,
          created.id,
          input.orgUnitIds ?? [],
        );
        await this.audit.record(
          actor,
          {
            action: 'user.created',
            targetType: 'user',
            targetId: created.id,
            details: {
              email: created.email,
              roleIds: input.roleIds,
              ...(input.roleExpiresAt && {
                roleExpiresAt: input.roleExpiresAt,
              }),
              invited: !input.password,
            },
            ip,
          },
          tx,
        );
        return created;
      })
      .catch(rethrowUnique('A user with this email already exists.'));
    // No password: the invitation is a link to set one (the reset flow, for an
    // account without a password), sent after the commit.
    if (!input.password) {
      this.passwordReset.request(user.email);
    }
    this.access.invalidate();
    return user;
  }

  /** `createUser()` for an address that has an account already. */
  private async addExisting(
    actor: UserPrincipal,
    tenantId: string,
    account: NonNullable<Awaited<ReturnType<UsersRepository['findByEmail']>>>,
    input: UserInput,
    ip?: string,
  ) {
    if (input.password !== undefined) {
      throw new ConflictException({
        code: 'account_exists',
        message:
          'This address has an account: it is added without a password, which only its owner sets.',
      });
    }
    if (!account.active) {
      throw new ConflictException('A user with this email already exists.');
    }
    const unclaimed = !account.emailVerified;
    await inTransaction(this.txHost, async (tx) => {
      await this.accounts
        .addMembership(tx, tenantId, account.id)
        .catch(rethrowUnique('This user is a member already.'));
      if (unclaimed) {
        await this.accounts.resetCredentials(tx, account.id);
      }
      await this.writeRoles(
        tx,
        userRoles,
        account.id,
        input.roleIds,
        input.roleExpiresAt,
      );
      await this.orgUnits.setUserUnits(tx, account.id, input.orgUnitIds ?? []);
      await this.audit.record(
        actor,
        {
          action: 'user.created',
          targetType: 'user',
          targetId: account.id,
          details: {
            email: account.email,
            roleIds: input.roleIds,
            ...(input.roleExpiresAt && { roleExpiresAt: input.roleExpiresAt }),
            existingAccount: true,
            invited: unclaimed,
          },
          ip,
        },
        tx,
      );
    });
    if (unclaimed) {
      this.passwordReset.request(account.email);
    }
    this.access.invalidate();
    return (await this.accounts.findMember(tenantId, account.id))!;
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
    // The account (its name, its password) is its owner's and spans their
    // tenants: an administrator changes it only while it belongs to this
    // tenant alone, or they would reach into the others (docs/tenancy.md).
    if (
      (changes.name !== undefined || changes.password !== undefined) &&
      (await this.accounts.membershipCount(id)) > 1
    ) {
      throw new ConflictException({
        code: 'account_shared',
        message:
          'This account belongs to other tenants too: only its owner changes its name or password.',
      });
    }
    if (changes.active === false && id === actor.id) {
      throw new ConflictException('You can’t deactivate yourself.');
    }
    const currentRoleIds = await this.roleIdsOf(id);
    if (id !== actor.id) {
      await this.assertAuthorityOver(
        actor,
        await this.rolePermissionsOf(currentRoleIds),
        before.email,
      );
    } else if (changes.orgUnitIds) {
      throw new ForbiddenException('You can’t change your own org units.');
    }
    if (changes.roleIds) {
      // Both what is given and what is taken away must be within the actor's own rights.
      const changed = [
        ...changes.roleIds.filter((roleId) => !currentRoleIds.includes(roleId)),
        ...currentRoleIds.filter(
          (roleId) => !changes.roleIds!.includes(roleId),
        ),
      ];
      await this.checkRoleGrant(actor, changed);
    }
    if (changes.password) {
      await this.breachedPasswords.assertNotBreached(
        changes.password,
        'password',
      );
    }
    const passwordHash = changes.password
      ? await this.passwordHasher.hash(changes.password)
      : undefined;

    const fields = {
      ...(changes.name !== undefined && { name: changes.name }),
      // A password an administrator chose makes the account unclaimed again:
      // its owner must prove the address before it joins another tenant.
      ...(passwordHash && { passwordHash, emailVerified: false }),
    };
    await inTransaction(this.txHost, async (tx) => {
      if (Object.keys(fields).length) {
        await this.accounts.update(tx, id, fields);
      }
      if (changes.active !== undefined) {
        // The membership, not the account: access to this tenant alone.
        await this.accounts.setMembershipActive(
          tx,
          tenantId,
          id,
          changes.active,
        );
      }
      if (changes.roleIds) {
        // Without roleExpiresAt, kept roles keep their end (and ended ones stay gone).
        const expiries =
          changes.roleExpiresAt ??
          (await this.liveExpiries(tx, 'user', id, changes.roleIds));
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await this.writeRoles(tx, userRoles, id, changes.roleIds, expiries);
      }
      if (changes.orgUnitIds) {
        await this.orgUnits.setUserUnits(tx, id, changes.orgUnitIds);
      }
      await this.assertAnAdministratorRemains(tx);
      if (changes.active === false && before.active) {
        // What waits on them (approvals, delegations) moves on, in this transaction.
        for (const listener of this.lifecycle.all()) {
          await listener.deactivated(tx, id, actor);
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
            ...(changes.name !== undefined && { name: changes.name }),
            ...(changes.active !== undefined && { active: changes.active }),
            ...(changes.roleIds !== undefined && {
              roleIds: { from: currentRoleIds, to: changes.roleIds },
              ...(changes.roleExpiresAt && {
                roleExpiresAt: changes.roleExpiresAt,
              }),
            }),
            ...(changes.orgUnitIds && { orgUnitIds: changes.orgUnitIds }),
            ...(passwordHash && { passwordReset: true }),
          },
          ip,
        },
        tx,
      );
    });
    // A new password signs the account out everywhere; a deactivation ends
    // its sessions and tokens in this tenant (the others go on; the
    // membership check would refuse them on their next request anyway).
    if (passwordHash) {
      await this.signInService.signOutEverywhere(id);
    } else if (changes.active === false) {
      await this.accounts.endTenantSessions(id, tenantId);
    }
    this.access.invalidate();
  }

  // Rules

  /**
   * You may act on someone (their password, activation, roles, units, keys;
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
    actor: UserPrincipal,
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

  private async checkRoleGrant(actor: UserPrincipal, roleIds: string[]) {
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

  private async assertAnAdministratorRemains(tx: Transaction) {
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

  private async roleIdsOf(userId: string) {
    const rows = await this.db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    return rows.map((row) => row.roleId);
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

  /** The ends of a holder's grants still running, for the roles it keeps. */
  private async liveExpiries(
    tx: Transaction,
    kind: 'user' | 'client',
    holderId: string,
    keep: string[],
  ) {
    const now = new Date();
    const rows =
      kind === 'user'
        ? await tx
            .select({
              roleId: userRoles.roleId,
              expiresAt: userRoles.expiresAt,
            })
            .from(userRoles)
            .where(
              and(eq(userRoles.userId, holderId), gt(userRoles.expiresAt, now)),
            )
        : await tx
            .select({
              roleId: apiClientRoles.roleId,
              expiresAt: apiClientRoles.expiresAt,
            })
            .from(apiClientRoles)
            .where(
              and(
                eq(apiClientRoles.clientId, holderId),
                gt(apiClientRoles.expiresAt, now),
              ),
            );
    return Object.fromEntries(
      rows
        .filter((row) => keep.includes(row.roleId))
        .map((row) => [row.roleId, row.expiresAt!.toISOString()]),
    );
  }

  /** A user's or a client's role grants, each with its end (none: never). */
  private async writeRoles(
    tx: Transaction,
    grants: typeof userRoles | typeof apiClientRoles,
    holderId: string,
    roleIds: string[],
    expiresAt: Record<string, string> = {},
  ) {
    const unique = [...new Set(roleIds)];
    const now = Date.now();
    for (const [roleId, when] of Object.entries(expiresAt)) {
      if (!unique.includes(roleId)) {
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
    if (!unique.length) {
      return;
    }
    const end = (roleId: string) =>
      expiresAt[roleId] ? new Date(expiresAt[roleId]) : null;
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
    const { client, key } = await inTransaction(this.txHost, async (tx) => {
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
    if (changes.roleIds) {
      const current = before.roles.map((role) => role.roleId);
      await this.checkRoleGrant(actor, [
        ...changes.roleIds.filter((roleId) => !current.includes(roleId)),
        ...current.filter((roleId) => !changes.roleIds!.includes(roleId)),
      ]);
    }
    await inTransaction(this.txHost, async (tx) => {
      if (changes.active !== undefined) {
        await this.clients.setActive(tx, actor, id, changes.active, ip);
      }
      if (changes.dailyQuota !== undefined) {
        await this.clients.setQuota(tx, actor, id, changes.dailyQuota, ip);
      }
      if (changes.roleIds) {
        const expiries =
          changes.roleExpiresAt ??
          (await this.liveExpiries(tx, 'client', id, changes.roleIds));
        await tx.delete(apiClientRoles).where(eq(apiClientRoles.clientId, id));
        await this.writeRoles(
          tx,
          apiClientRoles,
          id,
          changes.roleIds,
          expiries,
        );
        await this.audit.record(
          actor,
          {
            action: 'client.roles-changed',
            targetType: 'client',
            targetId: id,
            details: {
              roleIds: {
                from: before.roles.map((role) => role.roleId),
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
