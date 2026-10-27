import {
  type AnyColumn,
  and,
  Column,
  eq,
  gt,
  gte,
  is,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { openCursor, sealCursor } from './cursor-seal.js';
import type { FilterField } from './list-query.js';
import { utcMilliseconds } from '../database/utc-milliseconds.js';

/*
 * `?sort=-createdAt,title`: the order of a list, on declared `sortable`
 * fields, and the keyset cursor that pages it. Neither NestJS nor Drizzle
 * has keyset pagination over arbitrary columns, hence the code.
 */

/** At most this many sort fields. */
export const MAX_SORT = 3;

/** One sort field, resolved to what the SQL orders by. */
/** A column, an SQL expression of the row, or one that depends on the request (a search rank on `?q=`). */
export type ListColumn =
  AnyColumn | SQL | ((query: Record<string, unknown>) => SQL);

/** `column` for this request: a function is called with the query. */
export const columnOf = (
  column: ListColumn,
  query: Record<string, unknown>,
): AnyColumn | SQL => (typeof column === 'function' ? column(query) : column);

export interface SortBy {
  /** The field's name. */
  name: string;
  /** Where the rows hold the sort value (the cursor reads it there): the name, or `sortValueKey` when the field sorts by another expression. */
  key: string;
  /** What is ordered by: the column, a datetime to the millisecond (see sortExpression). */
  expression: ListColumn;
  /** The values in the cursor: datetimes as ISO strings, the rest as JSON. */
  type: FilterField['type'];
  desc: boolean;
  /** The sort source is a Drizzle column declared NOT NULL (never an SQL expression): an ascending keyset may then bound the index range. */
  notNull: boolean;
}

/**
 * A datetime sorts by the millisecond: Postgres keeps microseconds, a
 * JavaScript Date (and so the cursor) milliseconds. Ordering by the
 * truncated value makes the cursor's value exact; ties go to the id. An
 * index for this sort is on the same expression.
 */
const sortExpression = (field: FilterField): ListColumn => {
  const column = field.sort ?? field.column;
  if (field.type !== 'datetime') {
    return column;
  }
  return typeof column === 'function'
    ? (query) => utcMilliseconds(column(query))
    : utcMilliseconds(column);
};

/**
 * The key the rows hold a field's sort value under: its name, unless the
 * field sorts by another expression (`sort`: `lower(name)`), whose value
 * is selected next to the row under a key of its own, so the field's own
 * value stays what the client sees (`sortSelect`, `pick`).
 */
export const sortValueKey = (name: string, field: FilterField) =>
  field.sort ? `_sort_${name}` : name;

const isNotNullColumn = (source: ListColumn) =>
  is(source, Column) && source.notNull;

/** `-createdAt,title`: comma-separated, `-` for descending. */
export function sortSchema(fields: Record<string, FilterField>) {
  return z
    .string()
    .max(500)
    .transform((text, ctx): SortBy[] => {
      const sort: SortBy[] = [];
      const names = text.split(',').map((part) => part.trim());
      if (names.length > MAX_SORT) {
        ctx.addIssue({
          code: 'custom',
          message: `sort takes at most ${MAX_SORT} fields`,
        });
        return z.NEVER;
      }
      for (const part of names) {
        const desc = part.startsWith('-');
        const name = desc ? part.slice(1) : part;
        const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
        if (!field?.sortable) {
          ctx.addIssue({
            code: 'custom',
            message: `Not a sortable field of this list: "${name}"`,
          });
        } else if (sort.some((item) => item.name === name)) {
          ctx.addIssue({
            code: 'custom',
            message: `"${name}" is sorted twice`,
          });
        } else {
          sort.push({
            name,
            key: sortValueKey(name, field),
            expression: sortExpression(field),
            type: field.type,
            desc,
            notNull: isNotNullColumn(field.sort ?? field.column),
          });
        }
      }
      return sort;
    });
}

/** The sort as text, the way `?sort=` spells it: what a cursor belongs to. */
export const sortKey = (sort: readonly SortBy[]) =>
  sort.map((item) => `${item.desc ? '-' : ''}${item.name}`).join(',');

/**
 * The ORDER BY of a sort. NULLs are the largest value, in both directions
 * (Postgres' default, said out loud): last ascending, first descending.
 */
export const sortOrder = (
  sort: readonly SortBy[] = [],
  query: Record<string, unknown> = {},
) =>
  sort.map((item) =>
    item.desc
      ? sql`${columnOf(item.expression, query)} desc nulls first`
      : sql`${columnOf(item.expression, query)} asc nulls last`,
  );

/** What a sorted cursor holds, sealed: the last row's sort values and its id (the sort is the seal's context). */
interface CursorData {
  v: unknown[];
  id: string;
}

/**
 * The cursor after `row` on a sorted list: opaque to clients, sealed
 * (cursor-seal.ts) for this sort, so the sort values it carries, which may
 * be fields redaction hides on that row, are never readable.
 */
export function encodeCursor(
  sort: readonly SortBy[],
  row: Record<string, unknown> & { id: string },
) {
  const data: CursorData = { v: cursorValues(sort, row), id: row.id };
  return sealCursor(JSON.stringify(data), cursorContext(sort));
}

/**
 * A row's sort values as a cursor holds them (datetimes as ISO strings):
 * what `afterKeyset` compares with. Code that pages in-process (exports)
 * passes them as `after` without sealing a cursor.
 */
export const cursorValues = (
  sort: readonly SortBy[],
  row: Record<string, unknown>,
): unknown[] =>
  sort.map(({ key }) => {
    const value = row[key];
    return value instanceof Date ? value.toISOString() : (value ?? null);
  });

/** What a cursor is sealed for: its sort, as `?sort=` spells it. */
const cursorContext = (sort: readonly SortBy[]) => `sort:${sortKey(sort)}`;

const cursorValue = (type: FilterField['type']) => {
  switch (type) {
    case 'datetime':
      return z.iso.datetime({ offset: true });
    case 'date':
      return z.iso.date();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    default:
      return z.string().max(10_000);
  }
};

/**
 * The cursor of a sorted list, checked: sealed by this server for this
 * sort, with a value of the right type per field. `undefined`: not one (a
 * 400): changed, made for another sort, sealed with a key no longer in
 * CURSOR_KEYS, or not a cursor.
 */
export function decodeCursor(
  cursor: string,
  sort: readonly SortBy[],
  /** What the list's ids look like: UUIDs unless it says otherwise (`ListOptions.cursorId`). */
  idSchema: z.ZodType<string> = z.uuid(),
) {
  const plaintext = openCursor(cursor, cursorContext(sort));
  if (plaintext === undefined) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  // Sealed by this server, checked anyway: the values go into the SQL.
  const parsed = z
    .object({
      v: z.tuple(
        sort.map((item) => cursorValue(item.type).nullable()) as unknown as [
          z.ZodType,
          ...z.ZodType[],
        ],
      ),
      id: idSchema,
    })
    .safeParse(data);
  return parsed.success
    ? { after: parsed.data.v as unknown[], id: parsed.data.id }
    : undefined;
}

/**
 * The rows after the cursor's row, in sortOrder then id descending:
 * (a > x) or (a = x and b > y) or … or (a = x and b = y and id < lastId),
 * with "after" turned by each direction and NULL the largest value. That
 * OR is the exact set but not an index bound, so it comes in three shapes:
 * - all fields descending and no NULL value: one row comparison
 *   `(a, b, id) < (x, y, lastId)`, an index range (a NULL element excludes
 *   the row, and NULLs sort first descending, so it is exact);
 * - otherwise the OR behind a bound on the first field (`a <= x`, `a >= x`
 *   when ascending and NOT NULL, `a is null` when ascending past NULL);
 * - no bound where the rows after span two ranges: the first field
 *   ascending, nullable, past a value (`a > x` or NULL), or descending
 *   past NULL (the rest of the NULLs and every value). Those pages read
 *   the rows already passed.
 */
export function afterKeyset(
  sort: readonly SortBy[],
  after: readonly unknown[],
  id: AnyColumn,
  lastId: string,
  query: Record<string, unknown> = {},
): SQL | undefined {
  const columns = sort.map(
    (item) => columnOf(item.expression, query) as AnyColumn, // a column or SQL: both work
  );
  if (sort.every((item, index) => item.desc && after[index] !== null)) {
    // KEEP: Drizzle has no row-comparison helper.
    const values = sort.map((item, index) =>
      item.type === 'datetime'
        ? sql`${after[index]}::timestamptz`
        : sql`${after[index]}`,
    );
    return sql`(${sql.join([...columns, id], sql`, `)}) < (${sql.join([...values, sql`${lastId}`], sql`, `)})`;
  }
  const terms: (SQL | undefined)[] = [];
  const equal: (SQL | undefined)[] = [];
  sort.forEach((item, index) => {
    const value = after[index];
    const column = columns[index];
    const past =
      value === null
        ? item.desc
          ? isNotNull(column) // NULLs came first: every value is after
          : undefined // NULLs come last: nothing is after them on this field
        : item.desc
          ? lt(column, value)
          : or(gt(column, value), isNull(column));
    if (past) {
      terms.push(and(...equal, past));
    }
    equal.push(value === null ? isNull(column) : eq(column, value));
  });
  terms.push(and(...equal, lt(id, lastId)));
  const exact = or(...terms);
  const [first] = sort;
  const value = after[0];
  let bound: SQL | undefined;
  if (first && value !== null) {
    if (first.desc) {
      bound = lte(columns[0], value);
    } else if (first.notNull) {
      bound = gte(columns[0], value);
    }
  } else if (first && !first.desc) {
    bound = isNull(columns[0]);
  }
  return bound ? and(bound, exact) : exact;
}
