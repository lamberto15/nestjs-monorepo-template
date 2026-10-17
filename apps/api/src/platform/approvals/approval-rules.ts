import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import {
  teamTree,
  rolePermissions,
  roles,
  userTeams,
  userRoles,
  users,
} from '../../iam/iam.tables.js';
import type { ApprovalContext, ApproverRule } from './approval.types.js';
import { ApprovalsRegistry } from './approvals.registry.js';

/**
 * The built-in approver rules. Each is a provider that registers itself,
 * as a project's own rule does (docs/approvals.md, "Extending"). They read
 * roles, permissions and teams as they are when the stage starts.
 */

/** A role by its key (`editor`) or its id: roles made in the API have no key. */
const roleIs = (role: string) =>
  z.uuid().safeParse(role).success
    ? or(eq(roles.key, role), eq(roles.id, role))
    : eq(roles.key, role);

/** An unexpired grant. */
const granted = () =>
  or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, sql`now()`));

/** The requester's user id, when the requester is a user. */
const requesterUser = (context: ApprovalContext) =>
  context.requester.kind === 'user' ? context.requester.id : null;

/** `{ "type": "role", "role": "editor" }`: every active user holding the role. */
@Injectable()
export class RoleRule implements ApproverRule<{ role: string }> {
  readonly type = 'role';
  readonly label = 'Users holding a role';
  readonly schema = z.object({ role: z.string().min(1).max(100) }).strict();

  constructor(
    registry: ApprovalsRegistry,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {
    registry.addRule(this);
  }

  async resolve({ params }: ApprovalContext & { params: { role: string } }) {
    const rows = await database(this.txHost)
      .selectDistinct({ id: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(roleIs(params.role), granted(), eq(users.active, true)));
    return rows.map((row) => row.id);
  }
}

interface TeamRoleParams {
  role: string;
  levelsUp: number;
  nearest: boolean;
}

/**
 * `{ "type": "teamRole", "role": "team-lead" }`: users holding the role
 * in the requester's teams ("the lead of my team"). `levelsUp` starts
 * that many teams higher (1: the parent team, for an escalation to the
 * next level); with `nearest` (the default) it goes up the tree until it
 * finds someone other than the requester, so a lead's own request goes to
 * the lead above them.
 */
@Injectable()
export class TeamRoleRule implements ApproverRule<TeamRoleParams> {
  readonly type = 'teamRole';
  readonly label = "Users holding a role in the requester's team, or above";
  readonly schema = z
    .object({
      role: z.string().min(1).max(100),
      levelsUp: z.number().int().min(0).max(20).default(0),
      nearest: z.boolean().default(true),
    })
    .strict();

  constructor(
    registry: ApprovalsRegistry,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {
    registry.addRule(this);
  }

  async resolve(context: ApprovalContext & { params: TeamRoleParams }) {
    const me = requesterUser(context);
    if (!me) {
      return []; // an API client belongs to no team
    }
    const { role, levelsUp, nearest } = context.params;
    const db = database(this.txHost);
    // How far up the requester's teams go: the deepest ancestor's depth.
    const [{ depth } = { depth: null }] = await db
      .select({ depth: sql<number | null>`max(${teamTree.depth})` })
      .from(teamTree)
      .innerJoin(userTeams, eq(userTeams.teamId, teamTree.descendantId))
      .where(eq(userTeams.userId, me));
    const top = nearest ? (depth ?? -1) : levelsUp;
    for (let level = levelsUp; level <= top; level++) {
      // The teams `level` steps above each of the requester's teams.
      const teams = db
        .select({ id: teamTree.ancestorId })
        .from(teamTree)
        .innerJoin(userTeams, eq(userTeams.teamId, teamTree.descendantId))
        .where(and(eq(userTeams.userId, me), eq(teamTree.depth, level)));
      const rows = await db
        .selectDistinct({ id: userTeams.userId })
        .from(userTeams)
        .innerJoin(userRoles, eq(userRoles.userId, userTeams.userId))
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .innerJoin(users, eq(users.id, userTeams.userId))
        .where(
          and(
            inArray(userTeams.teamId, teams),
            roleIs(role),
            granted(),
            eq(users.active, true),
            ne(userTeams.userId, me),
          ),
        );
      if (rows.length) {
        return rows.map((row) => row.id);
      }
    }
    return [];
  }
}

interface PermissionParams {
  action: string;
  subject?: string;
}

/**
 * `{ "type": "permission", "action": "update" }`: users who may do the
 * action on the record, by their permissions (CASL, conditions included:
 * "may update notes of their teams"). The subject is the request's unless
 * given. Needs the feature's `record()`.
 */
@Injectable()
export class PermissionRule implements ApproverRule<PermissionParams> {
  readonly type = 'permission';
  readonly label = 'Users who may do an action on the record';
  readonly schema = z
    .object({
      action: z.string().min(1).max(100),
      subject: z.string().min(1).max(100).optional(),
    })
    .strict();
  /**
   * Candidates checked one by one: a bound, so a broad permission can't make
   * a stage start slow. Beyond it (in id order) users aren't considered: a
   * permission that wide wants a narrower rule (a role, a team).
   */
  private static readonly MAX_CANDIDATES = 2000;

  constructor(
    registry: ApprovalsRegistry,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly access: AccessService,
  ) {
    registry.addRule(this);
  }

  async resolve(context: ApprovalContext & { params: PermissionParams }) {
    const subject = context.params.subject ?? context.subject;
    const { action } = context.params;
    const record = await context.record();
    if (!record) {
      return [];
    }
    // Who holds the permission at all (or everything, as administrators do).
    const candidates = await database(this.txHost)
      .selectDistinct({ id: userRoles.userId })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(
        and(
          or(
            and(
              eq(rolePermissions.subject, subject),
              eq(rolePermissions.action, action),
            ),
            and(
              eq(rolePermissions.subject, 'all'),
              eq(rolePermissions.action, 'manage'),
            ),
          ),
          granted(),
          eq(users.active, true),
        ),
      )
      .orderBy(userRoles.userId)
      .limit(PermissionRule.MAX_CANDIDATES);
    const allowed: string[] = [];
    for (const { id } of candidates) {
      // The ability reads only the principal's kind and id.
      const principal = { kind: 'user', id } as UserPrincipal;
      if (await this.access.can(principal, action, subject, record)) {
        allowed.push(id);
      }
    }
    return allowed;
  }
}

/** `{ "type": "users", "userIds": ["…"] }`: these users. */
@Injectable()
export class UsersRule implements ApproverRule<{ userIds: string[] }> {
  readonly type = 'users';
  readonly label = 'Named users';
  readonly schema = z
    .object({ userIds: z.array(z.uuid()).min(1).max(50) })
    .strict();

  constructor(registry: ApprovalsRegistry) {
    registry.addRule(this);
  }

  async resolve({
    params,
  }: ApprovalContext & { params: { userIds: string[] } }) {
    return params.userIds;
  }
}

/** The built-in rules, for the platform module's providers. */
export const BUILT_IN_RULES = [
  RoleRule,
  TeamRoleRule,
  PermissionRule,
  UsersRule,
];
