import {
  count,
  desc,
  lt,
  sql,
  type AnyColumn,
  type SQL,
  type Subquery,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Database, Transaction } from '../database/drizzle.js';
import {
  afterKeyset,
  encodeCursor,
  type SortBy,
  sortOrder,
} from './list-sort.js';

/**
 * Cursor pagination, the same on every growing list: `?limit=50&cursor=<id>`
 * answers `{ items, nextCursor }`, newest first. Pass `nextCursor` back for
 * the next page; `null` means there is none. Ids are UUIDv7, ordered by
 * creation, so the last id of a page is where the next one starts: no
 * offsets, stable under inserts.
 *
 * `?count=true` adds `total` (see countPage): asked for when a screen shows
 * it, so the lists that don't pay nothing.
 *
 * `?sort=-createdAt,title` orders by declared fields, then by id; the
 * cursor is then opaque (the last row's sort values and id, keyset: a
 * page costs the same however deep, and stays stable under inserts).
 *
 * `?page=3` pages by number instead (`limit` rows a page; `count=true`
 * adds `pageCount`), for screens that jump to a page. Its cost (the rows
 * skipped are read) is bounded: no page starts past COUNT_CAP, where the
 * count stops too. Rows written between two requests may shift a row to
 * the next page, the known trade-off of page numbers.
 */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe('`nextCursor` of the previous page (the same `sort`).'),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`.',
    ),
  count: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe('true: add `total` (counted up to a cap; `totalCapped`).'),
});
/** A page query; `count` is optional for pages built in code (exports, jobs). */
export type PageQuery = Omit<
  z.infer<typeof pageQuerySchema>,
  'count' | 'page'
> & {
  count?: boolean;
  /** Set: the list pages by number, `limit` rows a page. */
  page?: number;
  /** The declared fields to order by (`?sort=`), before the id. */
  sort?: readonly SortBy[];
  /** With a sort and a cursor: the cursor row's sort values (`cursor` is its id). */
  after?: readonly unknown[];
};

/** The response of a paginated list. */
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        'Pass it as `cursor` for the next page; null: no more (and with `page`).',
      ),
    page: z.number().int().optional().describe('With `page`: this page.'),
    nextPage: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('With `page`: the next page; null: no more.'),
    pageCount: z
      .number()
      .int()
      .optional()
      .describe('With `page` and `count=true`: ceil(total / limit).'),
    total: z
      .number()
      .int()
      .optional()
      .describe(
        'With `count=true`: the rows matching the filters, all pages; the cap when totalCapped.',
      ),
    totalCapped: z
      .boolean()
      .optional()
      .describe('true: there are more than `total` (show "10,000+").'),
  });

/** The response of a list that is never long: everything, in `items`. */
export const listSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item) });

/** The ORDER BY of a page: the sort asked for, then the id, newest first (a total order). */
export const pageOrder = (id: AnyColumn, query: PageQuery): SQL[] => [
  ...sortOrder(query.sort, query),
  desc(id),
];

/** The rows a page by number skips; 0 for a cursor page. */
export const pageOffset = (query: PageQuery) =>
  query.page ? (query.page - 1) * query.limit : 0;

/**
 * The condition for the rows after `cursor`: `id < cursor` (newest first),
 * or with a sort, the keyset after the cursor's row.
 */
export function afterCursor(id: AnyColumn, query: PageQuery): SQL | undefined {
  if (!query.cursor) {
    return undefined;
  }
  return query.sort?.length && query.after
    ? afterKeyset(query.sort, query.after, id, query.cursor, query)
    : lt(id, query.cursor);
}

/**
 * Builds the page from rows fetched with `limit + 1` (in pageOrder, from
 * pageOffset): the extra row only says whether there is a next page.
 */
export function toPage<T extends { id: string }>(
  rows: T[],
  query: PageQuery,
  total?: PageTotal,
) {
  const items = rows.slice(0, query.limit);
  const more = rows.length > query.limit;
  if (query.page) {
    return {
      items,
      nextCursor: null,
      page: query.page,
      nextPage: more ? query.page + 1 : null,
      ...total,
      ...(total && { pageCount: Math.ceil(total.total / query.limit) }),
    };
  }
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: !more
      ? null
      : query.sort?.length
        ? encodeCursor(query.sort, last as T & Record<string, unknown>)
        : last.id,
    ...total,
  };
}

/** How far a list counts by default: past it, "10,000+" (counting stays fast on any table). */
export const COUNT_CAP = 10_000;

export type PageTotal = { total: number; totalCapped: boolean };

/**
 * The total of a list when the query asks for it (`count=true`), else
 * undefined. `where` is the list's filters and the caller's read filter,
 * without the cursor: the same total on every page, and only rows the
 * caller may see. Counts at most `cap` + 1 rows (a LIMIT under the count),
 * so a large table costs no more than `cap` index entries. Run it next to
 * the page's query (Promise.all).
 */
/**
 * `countPage()` for a query of its own (a join): the matching rows, capped,
 * as `select 1 … limit cap + 1`.
 */
export async function countMatching(
  db: Database | Transaction,
  matching: { limit(n: number): { as(alias: string): Subquery } },
  query: PageQuery,
  cap = COUNT_CAP,
): Promise<PageTotal | undefined> {
  if (!query.count) {
    return undefined;
  }
  const [{ rows }] = await db
    .select({ rows: count() })
    .from(matching.limit(cap + 1).as('matching'));
  return rows > cap
    ? { total: cap, totalCapped: true }
    : { total: rows, totalCapped: false };
}

export async function countPage(
  db: Database | Transaction,
  table: PgTable,
  where: SQL | undefined,
  query: PageQuery,
  cap = COUNT_CAP,
): Promise<PageTotal | undefined> {
  if (!query.count) {
    return undefined;
  }
  const matching = db
    .select({ one: sql`1` })
    .from(table)
    .where(where)
    .limit(cap + 1)
    .as('matching');
  const [{ rows }] = await db.select({ rows: count() }).from(matching);
  return rows > cap
    ? { total: cap, totalCapped: true }
    : { total: rows, totalCapped: false };
}
