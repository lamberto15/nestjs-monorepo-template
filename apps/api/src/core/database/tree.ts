import {
  type AnyColumn,
  type SQL,
  and,
  eq,
  getTableName,
  inArray,
  sql,
} from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Database, Transaction } from './drizzle.js';

/**
 * A closure table for a tree of rows (org units, categories, folders): one
 * row per (ancestor, descendant) pair, a node being its own ancestor at
 * depth 0. "Everything under X" is one indexed lookup at any depth, with no
 * recursive query; moving a subtree is two statements. Declare it next to
 * the node table, export both from schema.ts:
 *
 * ```ts
 * export const categories = pgTable('categories', { id: uuidPk(), parentId: uuid('parent_id'), … });
 * export const categoryTree = closureTable('category_tree', () => categories.id);
 * const tree = new Tree(categoryTree);
 * await tree.add(tx, id, parentId);              // after inserting the node
 * db.select().from(products).where(inArray(products.categoryId, tree.descendants(id)));
 * ```
 */
export function closureTable(name: string, node: () => AnyPgColumn) {
  return pgTable(
    name,
    {
      ancestorId: uuid('ancestor_id')
        .notNull()
        .references(node, { onDelete: 'cascade' }),
      descendantId: uuid('descendant_id')
        .notNull()
        .references(node, { onDelete: 'cascade' }),
      depth: integer('depth').notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.ancestorId, table.descendantId] }),
      index(`${name}_descendant_idx`).on(table.descendantId),
    ],
  );
}

export type ClosureTable = ReturnType<typeof closureTable>;

/** The operations of a closure table. */
export class Tree {
  constructor(private readonly closure: ClosureTable) {}

  /** Records a new node under `parentId` (null: a root). Call it in the node's insert transaction. */
  async add(tx: Database | Transaction, id: string, parentId: string | null) {
    await this.lock(tx);
    await tx
      .insert(this.closure)
      .values({ ancestorId: id, descendantId: id, depth: 0 });
    if (parentId) {
      await tx.execute(sql`
        insert into ${this.closure} (ancestor_id, descendant_id, depth)
        select ancestor_id, ${id}, depth + 1 from ${this.closure}
        where descendant_id = ${parentId}`);
    }
  }

  /**
   * Moves `id` and everything under it below `parentId` (null: to the root).
   * Refuses a move under itself or its own descendants (a cycle).
   */
  async move(tx: Transaction, id: string, parentId: string | null) {
    // Two concurrent moves (A under B, B under A) would each pass the cycle check alone.
    await this.lock(tx);
    if (parentId && (await this.isUnder(tx, parentId, id))) {
      throw new TreeCycleError(id, parentId);
    }
    // Detach the subtree from its old ancestors (it keeps its own inner paths)…
    await tx.execute(sql`
      delete from ${this.closure}
      where descendant_id in (select descendant_id from ${this.closure} where ancestor_id = ${id})
        and ancestor_id not in (select descendant_id from ${this.closure} where ancestor_id = ${id})`);
    // …then attach it under every ancestor of the new parent.
    if (parentId) {
      await tx.execute(sql`
        insert into ${this.closure} (ancestor_id, descendant_id, depth)
        select above.ancestor_id, below.descendant_id, above.depth + below.depth + 1
        from ${this.closure} above cross join ${this.closure} below
        where above.descendant_id = ${parentId} and below.ancestor_id = ${id}`);
    }
  }

  /** One change of this tree at a time (until the transaction ends). */
  private async lock(tx: Database | Transaction) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${getTableName(this.closure)}))`,
    );
  }

  /** Whether `id` is `ancestorId` or below it. */
  async isUnder(db: Database | Transaction, id: string, ancestorId: string) {
    const [row] = await db
      .select({ depth: this.closure.depth })
      .from(this.closure)
      .where(
        and(
          eq(this.closure.ancestorId, ancestorId),
          eq(this.closure.descendantId, id),
        ),
      );
    return !!row;
  }

  /** The ids at or below these nodes, as a subquery: `inArray(column, tree.descendants(ids))`. */
  descendants(ids: string | string[] | SQL) {
    const roots =
      typeof ids === 'string'
        ? eq(this.closure.ancestorId, ids)
        : Array.isArray(ids)
          ? inArray(this.closure.ancestorId, ids)
          : inArray(this.closure.ancestorId, ids);
    return this.selectFrom(this.closure.descendantId, roots);
  }

  /** The ids at or above this node, nearest first, as a subquery. */
  ancestors(id: string) {
    return this.selectFrom(
      this.closure.ancestorId,
      eq(this.closure.descendantId, id),
    );
  }

  private selectFrom(column: AnyColumn, where: SQL | undefined) {
    return sql`(select ${column} from ${this.closure} where ${where})`;
  }
}

/** A move that would put a node under itself. */
export class TreeCycleError extends Error {
  constructor(id: string, parentId: string) {
    super(`${parentId} is ${id} or below it: the move would make a cycle.`);
  }
}
