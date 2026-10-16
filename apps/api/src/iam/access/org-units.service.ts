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
import type { UserPrincipal } from '../auth/principal.js';
import { orgUnitTree, orgUnits, userOrgUnits } from '../iam.tables.js';
import { AccessService } from './access.service.js';

/**
 * The organization's units, in a tree kept by a closure table: create,
 * rename, move (a whole subtree at once), delete an empty unit, and put
 * users in units. Every change is audited, and drops the cached abilities
 * everywhere (`inMyUnits` reads the tree).
 */
@Injectable()
export class OrgUnitsService {
  readonly tree = new Tree(orgUnitTree);

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  /** Every unit, with its parent and depth, top-level first. */
  async list() {
    const [units, depths, members] = await Promise.all([
      this.db.select().from(orgUnits).orderBy(asc(orgUnits.name)),
      this.db
        .select({ id: orgUnitTree.descendantId, depth: count() })
        .from(orgUnitTree)
        .groupBy(orgUnitTree.descendantId),
      this.db
        .select({ id: userOrgUnits.orgUnitId, members: count() })
        .from(userOrgUnits)
        .groupBy(userOrgUnits.orgUnitId),
    ]);
    return units
      .map((unit) => ({
        ...unit,
        // A unit is its own ancestor: the count of its ancestors, minus one.
        depth: (depths.find((row) => row.id === unit.id)?.depth ?? 1) - 1,
        members: members.find((row) => row.id === unit.id)?.members ?? 0,
      }))
      .sort((a, b) => a.depth - b.depth);
  }

  async create(
    actor: UserPrincipal,
    input: { name: string; parentId?: string | null },
    ip?: string,
  ) {
    const unit = await inTransaction(this.txHost, async (tx) => {
      if (input.parentId) {
        await this.find(tx, input.parentId);
      }
      const [row] = await tx
        .insert(orgUnits)
        .values({ name: input.name, parentId: input.parentId ?? null })
        .returning();
      await this.tree.add(tx, row.id, row.parentId);
      await this.audit.record(
        actor,
        {
          action: 'org-unit.created',
          targetType: 'org-unit',
          targetId: row.id,
          details: { name: row.name, parentId: row.parentId },
          ip,
        },
        tx,
      );
      return row;
    });
    this.access.invalidate();
    return unit;
  }

  /** Renames a unit, or moves it (with everything under it) under another parent. */
  async update(
    actor: UserPrincipal,
    id: string,
    changes: { name?: string; parentId?: string | null },
    ip?: string,
  ) {
    const unit = await inTransaction(this.txHost, async (tx) => {
      const before = await this.find(tx, id);
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
              'A unit can’t move under itself or its own units.',
            );
          }
          throw error;
        }
      }
      const [row] = await tx
        .update(orgUnits)
        .set({
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.parentId !== undefined && { parentId: changes.parentId }),
        })
        .where(eq(orgUnits.id, id))
        .returning();
      await this.audit.record(
        actor,
        {
          action: 'org-unit.updated',
          targetType: 'org-unit',
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
    return unit;
  }

  /** Deletes a unit with no units under it and no members. */
  async remove(actor: UserPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const unit = await this.find(tx, id);
      const [{ children }] = await tx
        .select({ children: count() })
        .from(orgUnits)
        .where(eq(orgUnits.parentId, id));
      const [{ members }] = await tx
        .select({ members: count() })
        .from(userOrgUnits)
        .where(eq(userOrgUnits.orgUnitId, id));
      if (children > 0 || members > 0) {
        throw new ConflictException(
          'Move or delete its units, and its members, first.',
        );
      }
      await tx.delete(orgUnits).where(eq(orgUnits.id, id));
      await this.audit.record(
        actor,
        {
          action: 'org-unit.deleted',
          targetType: 'org-unit',
          targetId: id,
          details: { name: unit.name },
          ip,
        },
        tx,
      );
    });
    this.access.invalidate();
  }

  /** The units a user belongs to (not those below them). */
  async unitsOf(userId: string, db: Database | Transaction = this.db) {
    const rows = await db
      .select({ id: userOrgUnits.orgUnitId })
      .from(userOrgUnits)
      .where(eq(userOrgUnits.userId, userId));
    return rows.map((row) => row.id);
  }

  /** Replaces a user's units (in the change's transaction); the caller invalidates abilities. */
  async setUserUnits(tx: Transaction, userId: string, orgUnitIds: string[]) {
    const unique = [...new Set(orgUnitIds)];
    if (unique.length) {
      const found = await tx
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(inArray(orgUnits.id, unique));
      if (found.length !== unique.length) {
        throw new BadRequestException('Unknown org unit.');
      }
    }
    await tx.delete(userOrgUnits).where(eq(userOrgUnits.userId, userId));
    if (unique.length) {
      await tx
        .insert(userOrgUnits)
        .values(unique.map((orgUnitId) => ({ userId, orgUnitId })));
    }
  }

  private async find(db: Database | Transaction, id: string) {
    const [unit] = await db.select().from(orgUnits).where(eq(orgUnits.id, id));
    if (!unit) {
      throw new NotFoundException(`Org unit ${id} not found.`);
    }
    return unit;
  }
}
