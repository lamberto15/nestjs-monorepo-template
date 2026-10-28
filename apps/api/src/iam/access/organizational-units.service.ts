import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lt,
  or,
} from 'drizzle-orm';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import {
  isStillReferenced,
  pgErrorCode,
  UNIQUE_VIOLATION,
} from '../../core/database/errors.js';
import { Tree, TreeCycleError } from '../../core/database/tree.js';
import { AuditService } from '../audit/audit.service.js';
import type { SystemPrincipal, UserPrincipal } from '../auth/principal.js';
import {
  memberships,
  organizationalUnitClosure,
  organizationalUnitMemberships,
  organizationalUnits,
  type UnitRole,
  type UnitType,
  users,
} from '../iam.tables.js';
import { scimGroups } from '../sso/sso.tables.js';
import { AccessService } from './access.service.js';
import {
  currentMembership,
  unitIdsOf,
  type UnitsOfOptions,
} from './permissions.js';

/** The 409 of a change to a unit the tenant's IdP manages over SCIM. */
const managedByScim = (what: string) =>
  new ConflictException({
    code: 'unit_managed_by_scim',
    message: `${what}: the identity provider manages this unit over SCIM. Change it there.`,
  });

/** The 409 of a name a sibling already has (any case). */
const nameTaken = (name: string) =>
  new ConflictException({
    code: 'unit_name_taken',
    message: `A unit beside it is already named "${name}" (names are unique among siblings, ignoring case).`,
  });

const notEmpty = () =>
  new ConflictException({
    code: 'unit_not_empty',
    message:
      'Move or delete the units under it, end its memberships, and move what refers to it (records, saved views) first.',
  });

const rethrowNameTaken = (name: string) => (error: unknown) => {
  throw pgErrorCode(error) === UNIQUE_VIOLATION ? nameTaken(name) : error;
};

/**
 * The tenant's organizational units, in one tree kept by a closure table:
 * create, rename, retype, move (a whole subtree at once), delete an empty
 * unit, and the memberships of users in them, dated (`validFrom`,
 * `validTo`): ending one keeps it as history. Every change is audited, and
 * drops the cached abilities everywhere (the unit conditions read them).
 */
@Injectable()
export class OrganizationalUnitsService {
  readonly tree = new Tree(organizationalUnitClosure);

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  /** Every unit, with its parent, depth and current members, top-level first. */
  async list() {
    const now = new Date();
    const [rows, depths, members, managed] = await Promise.all([
      this.db
        .select()
        .from(organizationalUnits)
        .orderBy(asc(organizationalUnits.name)),
      this.db
        .select({ id: organizationalUnitClosure.descendantId, depth: count() })
        .from(organizationalUnitClosure)
        .groupBy(organizationalUnitClosure.descendantId),
      this.db
        .select({ id: organizationalUnitMemberships.unitId, members: count() })
        .from(organizationalUnitMemberships)
        .where(currentMembership(now))
        .groupBy(organizationalUnitMemberships.unitId),
      this.db.select({ id: scimGroups.unitId }).from(scimGroups),
    ]);
    const scim = new Set(managed.map((row) => row.id));
    return rows
      .map((unit) => ({
        ...unit,
        // A unit is its own ancestor: the count of its ancestors, minus one.
        depth: (depths.find((row) => row.id === unit.id)?.depth ?? 1) - 1,
        members: members.find((row) => row.id === unit.id)?.members ?? 0,
        managedByScim: scim.has(unit.id),
      }))
      .sort((a, b) => a.depth - b.depth);
  }

  /** `actor`: an administrator, or a system job (the demo seed, src/demo). */
  async create(
    actor: UserPrincipal | SystemPrincipal,
    input: { type: UnitType; name: string; parentId?: string | null },
    ip?: string,
  ) {
    const unit = await inTransaction(this.txHost, async (tx) => {
      if (input.parentId) {
        await this.find(tx, input.parentId);
      }
      const [row] = await tx
        .insert(organizationalUnits)
        .values({
          type: input.type,
          name: input.name,
          parentId: input.parentId ?? null,
        })
        .returning()
        .catch(rethrowNameTaken(input.name));
      await this.tree.add(tx, row.id, row.parentId);
      await this.audit.record(
        actor,
        {
          action: 'organizationalUnit.created',
          targetType: 'organizationalUnit',
          targetId: row.id,
          details: { type: row.type, name: row.name, parentId: row.parentId },
          ip,
        },
        tx,
      );
      return row;
    });
    this.access.invalidate();
    return unit;
  }

  /** Renames or retypes a unit, or moves it (with everything under it) under another parent. */
  async update(
    actor: UserPrincipal,
    id: string,
    changes: { type?: UnitType; name?: string; parentId?: string | null },
    ip?: string,
  ) {
    const unit = await inTransaction(this.txHost, async (tx) => {
      const before = await this.find(tx, id);
      if ((await this.scimManaged(tx, [id])).size > 0) {
        throw managedByScim('Not changed');
      }
      const moved =
        changes.parentId !== undefined && changes.parentId !== before.parentId;
      if (moved) {
        if (changes.parentId) {
          await this.find(tx, changes.parentId);
        }
        try {
          await this.tree.move(tx, id, changes.parentId ?? null);
        } catch (error) {
          if (error instanceof TreeCycleError) {
            throw new ConflictException(
              'A unit can’t move under itself or a unit below it.',
            );
          }
          throw error;
        }
      }
      const [row] = await tx
        .update(organizationalUnits)
        .set({
          ...(changes.type !== undefined && { type: changes.type }),
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.parentId !== undefined && { parentId: changes.parentId }),
        })
        .where(eq(organizationalUnits.id, id))
        .returning()
        .catch(rethrowNameTaken(changes.name ?? before.name));
      await this.audit.record(
        actor,
        {
          action: 'organizationalUnit.updated',
          targetType: 'organizationalUnit',
          targetId: id,
          details: {
            ...(changes.type !== undefined && {
              type: { from: before.type, to: changes.type },
            }),
            ...(changes.name !== undefined && {
              name: { from: before.name, to: changes.name },
            }),
            ...(moved && {
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

  /**
   * Deletes an empty unit: none under it, no current or future membership,
   * nothing referring to it (records, saved views). No cascade: a 409
   * `unit_not_empty` otherwise. Its ended memberships go with it.
   */
  async remove(actor: UserPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const unit = await this.find(tx, id);
      if ((await this.scimManaged(tx, [id])).size > 0) {
        throw managedByScim('Not deleted');
      }
      const [[{ children }], [{ members }]] = await Promise.all([
        tx
          .select({ children: count() })
          .from(organizationalUnits)
          .where(eq(organizationalUnits.parentId, id)),
        tx
          .select({ members: count() })
          .from(organizationalUnitMemberships)
          .where(
            and(
              eq(organizationalUnitMemberships.unitId, id),
              or(
                isNull(organizationalUnitMemberships.validTo),
                gt(organizationalUnitMemberships.validTo, new Date()),
              ),
            ),
          ),
      ]);
      if (children > 0 || members > 0) {
        throw notEmpty();
      }
      // What other groups' and features' tables refer to it (records,
      // notes, saved views) is theirs to know: their keys restrict the delete.
      await tx
        .delete(organizationalUnits)
        .where(eq(organizationalUnits.id, id))
        .catch((error: unknown) => {
          throw isStillReferenced(error) ? notEmpty() : error;
        });
      await this.audit.record(
        actor,
        {
          action: 'organizationalUnit.deleted',
          targetType: 'organizationalUnit',
          targetId: id,
          details: { type: unit.type, name: unit.name },
          ip,
        },
        tx,
      );
    });
    this.access.invalidate();
  }

  /**
   * The units a user is a current member of (`role`: only those they hold
   * that role in), and with `below` every unit under them: the one lookup
   * of "my units" (settings, saved views, approvals, a record's unit).
   */
  async unitsOf(
    userId: string,
    options: UnitsOfOptions = {},
    db: Database | Transaction = this.db,
  ) {
    const rows = await db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(inArray(organizationalUnits.id, unitIdsOf(userId, options)));
    return rows.map((row) => row.id);
  }

  /** The one unit a user is a current member of; null when none or several (a record's unit). */
  async onlyUnitOf(userId: string, db: Database | Transaction = this.db) {
    const ids = await this.unitsOf(userId, {}, db);
    return ids.length === 1 ? ids[0]! : null;
  }

  /** A unit's memberships, current and past, latest first, with each member's name and email. */
  async members(unitId: string) {
    await this.find(this.db, unitId);
    return this.db
      .select({
        ...getTableColumns(organizationalUnitMemberships),
        name: users.name,
        email: users.email,
      })
      .from(organizationalUnitMemberships)
      .innerJoin(users, eq(users.id, organizationalUnitMemberships.userId))
      .where(eq(organizationalUnitMemberships.unitId, unitId))
      .orderBy(
        desc(organizationalUnitMemberships.validFrom),
        asc(organizationalUnitMemberships.userId),
      );
  }

  /**
   * Opens a membership of `userId` in the unit, as a member or its lead,
   * from `validFrom` (default now) until `validTo` (default open). One
   * open membership per unit and user: a second is a 409.
   */
  async addMember(
    actor: UserPrincipal,
    unitId: string,
    input: {
      userId: string;
      role?: UnitRole;
      validFrom?: string;
      validTo?: string | null;
    },
    ip?: string,
  ) {
    this.assertNotSelf(actor, input.userId);
    const row = await inTransaction(this.txHost, async (tx) => {
      await this.find(tx, unitId);
      await this.assertChangeable(tx, unitId);
      const [member] = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.userId, input.userId));
      if (!member) {
        throw new BadRequestException('Unknown user.');
      }
      if (await this.openMembership(tx, unitId, input.userId)) {
        throw new ConflictException(
          'The user is already a member of this unit: change their role or end it first.',
        );
      }
      const validFrom = input.validFrom
        ? new Date(input.validFrom)
        : new Date();
      const validTo = input.validTo ? new Date(input.validTo) : null;
      if (validTo && validTo <= validFrom) {
        throw new BadRequestException('validTo must be after validFrom.');
      }
      const [created] = await tx
        .insert(organizationalUnitMemberships)
        .values({
          unitId,
          userId: input.userId,
          role: input.role ?? 'member',
          validFrom,
          validTo,
        })
        .returning();
      await this.audit.record(
        actor,
        {
          action: 'organizationalUnit.member-added',
          targetType: 'organizationalUnit',
          targetId: unitId,
          details: {
            userId: created.userId,
            role: created.role,
            validFrom: created.validFrom,
            validTo: created.validTo,
          },
          ip,
        },
        tx,
      );
      return created;
    });
    this.access.invalidate();
    return row;
  }

  /** Changes a member's role: the open membership ends now and a new one opens (history kept). */
  async changeMemberRole(
    actor: UserPrincipal,
    unitId: string,
    userId: string,
    role: UnitRole,
    ip?: string,
  ) {
    this.assertNotSelf(actor, userId);
    const row = await inTransaction(this.txHost, async (tx) => {
      await this.find(tx, unitId);
      await this.assertChangeable(tx, unitId);
      const open = await this.openMembership(tx, unitId, userId);
      if (!open) {
        throw new NotFoundException('The user is not a member of this unit.');
      }
      if (open.role === role) {
        return open;
      }
      const now = new Date();
      let changed: typeof open;
      if (open.validFrom >= now) {
        // Not started yet: nothing to keep as history.
        [changed] = await tx
          .update(organizationalUnitMemberships)
          .set({ role })
          .where(eq(organizationalUnitMemberships.id, open.id))
          .returning();
      } else {
        await this.end(tx, open.id, now);
        [changed] = await tx
          .insert(organizationalUnitMemberships)
          .values({
            unitId,
            userId,
            role,
            validFrom: now,
            validTo: open.validTo,
          })
          .returning();
      }
      await this.audit.record(
        actor,
        {
          action: 'organizationalUnit.member-role-changed',
          targetType: 'organizationalUnit',
          targetId: unitId,
          details: { userId, role: { from: open.role, to: role } },
          ip,
        },
        tx,
      );
      return changed;
    });
    this.access.invalidate();
    return row;
  }

  /** Ends a user's open membership of the unit now (kept as history; one not started yet is dropped). */
  async removeMember(
    actor: UserPrincipal,
    unitId: string,
    userId: string,
    ip?: string,
  ) {
    this.assertNotSelf(actor, userId);
    await inTransaction(this.txHost, async (tx) => {
      await this.find(tx, unitId);
      await this.assertChangeable(tx, unitId);
      const open = await this.openMembership(tx, unitId, userId);
      if (!open) {
        throw new NotFoundException('The user is not a member of this unit.');
      }
      await this.end(tx, open.id, new Date());
      await this.audit.record(
        actor,
        {
          action: 'organizationalUnit.member-removed',
          targetType: 'organizationalUnit',
          targetId: unitId,
          details: { userId, role: open.role },
          ip,
        },
        tx,
      );
    });
    this.access.invalidate();
  }

  /**
   * Sets which units a user is in (in the change's transaction; the
   * caller invalidates abilities): a unit left ends its membership, a new
   * one opens as a member (as its lead when in `led`: the demo seed), one
   * kept keeps its role. A unit the IdP manages
   * over SCIM keeps its members as SCIM left them: sending one more, or
   * one fewer, is a 409 `unit_managed_by_scim`.
   */
  async setUserUnits(
    tx: Transaction,
    userId: string,
    unitIds: string[],
    led: string[] = [],
  ) {
    const unique = [...new Set(unitIds)];
    if ((await this.existing(tx, unique)).length !== unique.length) {
      throw new BadRequestException('Unknown organizational unit.');
    }
    const now = new Date();
    const open = await tx
      .select()
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.userId, userId),
          or(
            isNull(organizationalUnitMemberships.validTo),
            gt(organizationalUnitMemberships.validTo, now),
          ),
        ),
      );
    // Only started memberships can be left: one dated ahead isn't among the
    // user's units yet, so a list sent back without it keeps it.
    const left = open.filter(
      (row) => row.validFrom <= now && !unique.includes(row.unitId),
    );
    const joined = unique.filter(
      (id) => !open.some((row) => row.unitId === id),
    );
    const changed = [...left.map((row) => row.unitId), ...joined];
    if ((await this.scimManaged(tx, changed)).size > 0) {
      throw managedByScim('Members not changed');
    }
    for (const row of left) {
      await this.end(tx, row.id, now);
    }
    if (joined.length) {
      await tx.insert(organizationalUnitMemberships).values(
        joined.map((unitId) => ({
          unitId,
          userId,
          role: led.includes(unitId) ? ('lead' as const) : ('member' as const),
          validFrom: now,
        })),
      );
    }
  }

  /**
   * The unit's current members become `userIds` (a SCIM group's, as its
   * IdP sends them): a member left out has their membership ended, a new
   * one joins as a member. Returns what changed, for the audit entry.
   */
  async setMembers(tx: Transaction, unitId: string, userIds: string[]) {
    const wanted = [...new Set(userIds)];
    const now = new Date();
    const open = await tx
      .select()
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.unitId, unitId),
          or(
            isNull(organizationalUnitMemberships.validTo),
            gt(organizationalUnitMemberships.validTo, now),
          ),
        ),
      );
    const removed = open.filter((row) => !wanted.includes(row.userId));
    const added = wanted.filter(
      (userId) => !open.some((row) => row.userId === userId),
    );
    for (const row of removed) {
      await this.end(tx, row.id, now);
    }
    if (added.length) {
      await tx
        .insert(organizationalUnitMemberships)
        .values(added.map((userId) => ({ unitId, userId, validFrom: now })));
    }
    return { added, removed: removed.map((row) => row.userId) };
  }

  /** Refuses ids that aren't this tenant's units (400). */
  async assertExist(ids: string[]) {
    const unique = [...new Set(ids)];
    if ((await this.existing(this.db, unique)).length !== unique.length) {
      throw new BadRequestException('Unknown organizational unit.');
    }
  }

  /** Those of `ids` that are this tenant's units now (an invitation's, accepted later). */
  async existing(db: Database | Transaction, ids: string[]) {
    if (!ids.length) {
      return [];
    }
    const found = await db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(inArray(organizationalUnits.id, [...new Set(ids)]));
    return found.map((row) => row.id);
  }

  /** An administrator never changes their own units: what they see would follow. */
  private assertNotSelf(actor: UserPrincipal, userId: string) {
    if (actor.id === userId) {
      throw new ForbiddenException('You can’t change your own units.');
    }
  }

  private async assertChangeable(tx: Transaction, unitId: string) {
    if ((await this.scimManaged(tx, [unitId])).size > 0) {
      throw managedByScim('Members not changed');
    }
  }

  /** The user's membership of the unit that hasn't ended (current, or dated ahead). */
  private async openMembership(
    tx: Transaction,
    unitId: string,
    userId: string,
  ) {
    const [row] = await tx
      .select()
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.unitId, unitId),
          eq(organizationalUnitMemberships.userId, userId),
          or(
            isNull(organizationalUnitMemberships.validTo),
            gt(organizationalUnitMemberships.validTo, new Date()),
          ),
        ),
      )
      .orderBy(desc(organizationalUnitMemberships.validFrom))
      .limit(1);
    return row;
  }

  /** Ends a membership at `at`; one that hadn't started by then never counted, and goes. */
  private async end(tx: Transaction, id: string, at: Date) {
    const ended = await tx
      .update(organizationalUnitMemberships)
      .set({ validTo: at })
      .where(
        and(
          eq(organizationalUnitMemberships.id, id),
          lt(organizationalUnitMemberships.validFrom, at),
        ),
      )
      .returning({ id: organizationalUnitMemberships.id });
    if (!ended.length) {
      await tx
        .delete(organizationalUnitMemberships)
        .where(eq(organizationalUnitMemberships.id, id));
    }
  }

  /** Those of these units the tenant's IdP manages over SCIM (iam/sso/scim). */
  private async scimManaged(db: Database | Transaction, ids: string[]) {
    if (ids.length === 0) {
      return new Set<string>();
    }
    const rows = await db
      .select({ id: scimGroups.unitId })
      .from(scimGroups)
      .where(inArray(scimGroups.unitId, ids));
    return new Set(rows.map((row) => row.id));
  }

  private async find(db: Database | Transaction, id: string) {
    const [unit] = await db
      .select()
      .from(organizationalUnits)
      .where(eq(organizationalUnits.id, id));
    if (!unit) {
      throw new NotFoundException(`Organizational unit ${id} not found.`);
    }
    return unit;
  }
}
