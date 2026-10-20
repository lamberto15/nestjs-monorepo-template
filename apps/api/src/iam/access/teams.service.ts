import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { Tree, TreeCycleError } from '../../core/database/tree.js';
import { AuditService } from '../audit/audit.service.js';
import type { SystemPrincipal, UserPrincipal } from '../auth/principal.js';
import { teamTree, teams, userTeams } from '../iam.tables.js';
import { scimGroups } from '../sso/sso.tables.js';
import { AccessService } from './access.service.js';

/** The 409 of a change to a team the tenant's IdP manages over SCIM. */
const managedByScim = (what: string) =>
  new ConflictException({
    code: 'team_managed_by_scim',
    message: `${what}: the identity provider manages this team over SCIM. Change it there.`,
  });

/**
 * The organization's teams, in a tree kept by a closure table: create,
 * rename, move (a whole subtree at once), delete an empty team, and put
 * users in teams. Every change is audited, and drops the cached abilities
 * everywhere (`inMyTeams` reads the tree).
 */
@Injectable()
export class TeamsService {
  readonly tree = new Tree(teamTree);

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  /** Every team, with its parent and depth, top-level first. */
  async list() {
    const [rows, depths, members, managed] = await Promise.all([
      this.db.select().from(teams).orderBy(asc(teams.name)),
      this.db
        .select({ id: teamTree.descendantId, depth: count() })
        .from(teamTree)
        .groupBy(teamTree.descendantId),
      this.db
        .select({ id: userTeams.teamId, members: count() })
        .from(userTeams)
        .groupBy(userTeams.teamId),
      this.db.select({ id: scimGroups.teamId }).from(scimGroups),
    ]);
    const scim = new Set(managed.map((row) => row.id));
    return rows
      .map((team) => ({
        ...team,
        // A team is its own ancestor: the count of its ancestors, minus one.
        depth: (depths.find((row) => row.id === team.id)?.depth ?? 1) - 1,
        members: members.find((row) => row.id === team.id)?.members ?? 0,
        managedByScim: scim.has(team.id),
      }))
      .sort((a, b) => a.depth - b.depth);
  }

  /** `actor`: an administrator, or a system job (the demo seed, src/demo). */
  async create(
    actor: UserPrincipal | SystemPrincipal,
    input: { name: string; parentId?: string | null },
    ip?: string,
  ) {
    const team = await inTransaction(this.txHost, async (tx) => {
      if (input.parentId) {
        await this.find(tx, input.parentId);
      }
      const [row] = await tx
        .insert(teams)
        .values({ name: input.name, parentId: input.parentId ?? null })
        .returning();
      await this.tree.add(tx, row.id, row.parentId);
      await this.audit.record(
        actor,
        {
          action: 'team.created',
          targetType: 'team',
          targetId: row.id,
          details: { name: row.name, parentId: row.parentId },
          ip,
        },
        tx,
      );
      return row;
    });
    this.access.invalidate();
    return team;
  }

  /** Renames a team, or moves it (with everything under it) under another parent. */
  async update(
    actor: UserPrincipal,
    id: string,
    changes: { name?: string; parentId?: string | null },
    ip?: string,
  ) {
    const team = await inTransaction(this.txHost, async (tx) => {
      const before = await this.find(tx, id);
      if ((await this.scimManaged(tx, [id])).size > 0) {
        throw managedByScim('Not renamed or moved');
      }
      if (
        changes.parentId !== undefined &&
        changes.parentId !== before.parentId
      ) {
        if (changes.parentId) {
          await this.find(tx, changes.parentId);
        }
        try {
          await this.tree.move(tx, id, changes.parentId);
        } catch (error) {
          if (error instanceof TreeCycleError) {
            throw new BadRequestException(
              'A team can’t move under itself or its own teams.',
            );
          }
          throw error;
        }
      }
      const [row] = await tx
        .update(teams)
        .set({
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.parentId !== undefined && { parentId: changes.parentId }),
        })
        .where(eq(teams.id, id))
        .returning();
      await this.audit.record(
        actor,
        {
          action: 'team.updated',
          targetType: 'team',
          targetId: id,
          details: {
            ...(changes.name !== undefined && {
              name: { from: before.name, to: changes.name },
            }),
            ...(changes.parentId !== undefined && {
              parentId: { from: before.parentId, to: changes.parentId },
            }),
          },
          ip,
        },
        tx,
      );
      return row;
    });
    this.access.invalidate();
    return team;
  }

  /** Deletes a team with no teams under it and no members. */
  async remove(actor: UserPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const team = await this.find(tx, id);
      if ((await this.scimManaged(tx, [id])).size > 0) {
        throw managedByScim('Not deleted');
      }
      const [{ children }] = await tx
        .select({ children: count() })
        .from(teams)
        .where(eq(teams.parentId, id));
      const [{ members }] = await tx
        .select({ members: count() })
        .from(userTeams)
        .where(eq(userTeams.teamId, id));
      if (children > 0 || members > 0) {
        throw new ConflictException(
          'Move or delete its teams, and its members, first.',
        );
      }
      await tx.delete(teams).where(eq(teams.id, id));
      await this.audit.record(
        actor,
        {
          action: 'team.deleted',
          targetType: 'team',
          targetId: id,
          details: { name: team.name },
          ip,
        },
        tx,
      );
    });
    this.access.invalidate();
  }

  /** The teams a user belongs to (not those below them). */
  async teamsOf(userId: string, db: Database | Transaction = this.db) {
    const rows = await db
      .select({ id: userTeams.teamId })
      .from(userTeams)
      .where(eq(userTeams.userId, userId));
    return rows.map((row) => row.id);
  }

  /**
   * Replaces a user's teams (in the change's transaction); the caller
   * invalidates abilities. A team the IdP manages over SCIM keeps its
   * members as SCIM left them: sending one more, or one fewer, is a 409
   * `team_managed_by_scim`.
   */
  async setUserTeams(tx: Transaction, userId: string, teamIds: string[]) {
    const unique = [...new Set(teamIds)];
    if (unique.length) {
      const found = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(inArray(teams.id, unique));
      if (found.length !== unique.length) {
        throw new BadRequestException('Unknown team.');
      }
    }
    const current = await this.teamsOf(userId, tx);
    const changed = [
      ...unique.filter((id) => !current.includes(id)),
      ...current.filter((id) => !unique.includes(id)),
    ];
    if ((await this.scimManaged(tx, changed)).size > 0) {
      throw managedByScim('Members not changed');
    }
    await tx.delete(userTeams).where(eq(userTeams.userId, userId));
    if (unique.length) {
      await tx
        .insert(userTeams)
        .values(unique.map((teamId) => ({ userId, teamId })));
    }
  }

  /** Those of these teams the tenant's IdP manages over SCIM (iam/sso/scim). */
  private async scimManaged(db: Database | Transaction, ids: string[]) {
    if (ids.length === 0) {
      return new Set<string>();
    }
    const rows = await db
      .select({ id: scimGroups.teamId })
      .from(scimGroups)
      .where(inArray(scimGroups.teamId, ids));
    return new Set(rows.map((row) => row.id));
  }

  /** Refuses ids that aren't this tenant's teams (400). */
  async assertExist(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) {
      return;
    }
    const found = await database(this.txHost)
      .select({ id: teams.id })
      .from(teams)
      .where(inArray(teams.id, unique));
    if (found.length !== unique.length) {
      throw new BadRequestException('Unknown team.');
    }
  }

  /** Those of `ids` that are this tenant's teams now (an invitation's, accepted later). */
  async existing(tx: Transaction, ids: string[]) {
    if (!ids.length) {
      return [];
    }
    const found = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(inArray(teams.id, [...new Set(ids)]));
    return found.map((row) => row.id);
  }

  private async find(db: Database | Transaction, id: string) {
    const [team] = await db.select().from(teams).where(eq(teams.id, id));
    if (!team) {
      throw new NotFoundException(`Team ${id} not found.`);
    }
    return team;
  }
}
