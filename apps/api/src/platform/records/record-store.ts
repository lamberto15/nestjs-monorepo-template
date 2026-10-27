import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, getTableColumns, isNotNull, isNull, sql } from 'drizzle-orm';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { List, ListQuery } from '../../core/http/list-query.js';
import { LegalHoldsService } from '../../iam/holds/legal-holds.service.js';
import { TeamsService } from '../../iam/access/teams.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from './record.js';
import {
  RECORD_DECLARATION,
  RECORD_TABLE,
  RecordLifecycle,
  type RecordRow,
} from './record-contract.js';

type RecordTable = PgTable & Record<string, AnyPgColumn>;

/**
 * The queries of a record's table whose shape its declaration decides
 * (record.ts: `softDelete`, `team`), for the feature's service: one record
 * or a page of them (the recycle bin left out, or only it), a new record's
 * owner and team, a delete (to the recycle bin, or for good), a restore. The
 * service keeps the transaction, the audit entry and the business logic, and
 * calls these inside them; flipping `softDelete` or `team` in the
 * declaration changes no code of the feature's. Provided by recordParts().
 */
@Injectable()
export class RecordStore {
  constructor(
    @Inject(RECORD_DECLARATION) private readonly declaration: RecordDeclaration,
    @Inject(RECORD_TABLE) private readonly table: RecordTable,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly teams: TeamsService,
    private readonly lifecycle: RecordLifecycle,
    private readonly holds: LegalHoldsService,
    private readonly quotas: TenantQuotas,
    private readonly access: AccessService,
  ) {
    // The tenant's limit on this feature's records (docs/tenancy.md, "Quotas").
    // The recycle bin is not counted: those are deleted.
    const { subject, softDelete } = declaration;
    quotas.count(`records:${subject}`, async (db) => {
      const table = this.table;
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(softDelete ? isNull(table.deletedAt!) : undefined);
      return row?.n ?? 0;
    });
  }

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  /**
   * The columns a new record's owner sets: `ownerId`, and with teams the
   * owner's team (a user's first one; none for an API client). Every
   * create calls it, in its transaction, so it is also where the tenant's
   * record limit for this feature is enforced (422 `quota_exceeded`, under
   * the limit's lock): a hook every generated service already has.
   */
  async owner(owner: Principal, tx: Transaction) {
    await this.quotas.assertRoom(
      tx,
      requireTenantId(),
      `records:${this.declaration.subject}`,
    );
    return {
      ownerId: principalKey(owner),
      ...(this.declaration.team && {
        teamId:
          owner.kind === 'user'
            ? ((await this.teams.teamsOf(owner.id, tx))[0] ?? null)
            : null,
      }),
    };
  }

  /**
   * One, or a 404. With a recycle bin, deleted ones are found only with
   * `deleted` (and only they); without one, `deleted` finds nothing.
   */
  async findOne<Row extends RecordRow>(
    id: string,
    db: Database | Transaction = this.db,
    { deleted = false }: { deleted?: boolean } = {},
  ): Promise<Row> {
    const table = this.table;
    const soft = this.declaration.softDelete;
    const [row] =
      deleted && !soft
        ? []
        : await db
            .select()
            .from(table)
            .where(
              and(
                eq(table.id!, id),
                soft
                  ? deleted
                    ? isNotNull(table.deletedAt!)
                    : isNull(table.deletedAt!)
                  : undefined,
              ),
            );
    if (!row) {
      const noun = this.declaration.noun;
      throw new NotFoundException(
        `${noun[0]!.toUpperCase()}${noun.slice(1)} ${id} not found.`,
      );
    }
    return row as Row;
  }

  /** One live record locked until the caller's transaction ends, or a 404. */
  async lock<Row extends RecordRow>(tx: Transaction, id: string): Promise<Row> {
    const table = this.table;
    const [row] = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.id!, id),
          this.declaration.softDelete ? isNull(table.deletedAt!) : undefined,
        ),
      )
      .for('update');
    if (!row) {
      const noun = this.declaration.noun;
      throw new NotFoundException(
        `${noun[0]!.toUpperCase()}${noun.slice(1)} ${id} not found.`,
      );
    }
    return row as Row;
  }

  /**
   * A page of the records `user` may read matching the list's query, newest
   * first. The read filter (AccessService: the recycle bin, `?deleted=true`,
   * is for those who may restore) and the query's `where` compose here, so a
   * controller passes the parsed query and builds no predicate. `list` is the
   * one the query was parsed with (custom fields included).
   */
  async findPage<Row extends RecordRow>(
    user: Principal,
    list: List,
    query: ListQuery,
  ) {
    const table = this.table;
    const where = and(
      await this.access.sqlFilter(
        user,
        this.declaration.subject,
        query.deleted ? 'restore' : 'read',
        { deleted: query.deleted === true },
      ),
      list.where(query),
    );
    // Sort values that aren't columns (custom fields), for the cursor.
    const extra = list.sortSelect(query);
    const [rows, total] = await Promise.all([
      this.db
        .select({ ...getTableColumns(table), ...extra })
        .from(table)
        .where(and(where, afterCursor(table.id!, query)))
        .orderBy(...pageOrder(table.id!, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, table, where, query),
    ]);
    return toPage(rows as Row[], query, total);
  }

  /** Deletes one: to the recycle bin (restorable until purged) when it has one, else for good; its `events` follow. */
  async delete(tx: Transaction, by: Principal, row: RecordRow) {
    const table = this.table;
    // A 409 `legal_hold`, bin or not (docs/retention.md).
    await this.holds.assertNotHeld(this.declaration.subject, [row.id], tx);
    await this.lifecycle.deleting(tx, { row, by });
    if (this.declaration.softDelete) {
      const [deleted] = await tx
        .update(table)
        .set({ deletedAt: new Date(), deletedBy: principalKey(by) })
        .where(eq(table.id!, row.id))
        .returning();
      await this.lifecycle.deleted(tx, { row: deleted as RecordRow });
    } else {
      await tx.delete(table).where(eq(table.id!, row.id));
      await this.lifecycle.deleted(tx, { row });
    }
  }

  /** Out of the recycle bin: the record as it is now. */
  async restore<Row extends RecordRow>(
    tx: Transaction,
    row: RecordRow,
  ): Promise<Row> {
    if (!this.declaration.softDelete) {
      throw new NotFoundException(
        `${this.declaration.subject} has no recycle bin (softDelete: false).`,
      );
    }
    const table = this.table;
    const [restored] = await tx
      .update(table)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(table.id!, row.id))
      .returning();
    await this.lifecycle.restored(tx, { row: restored as RecordRow });
    return restored as Row;
  }
}
