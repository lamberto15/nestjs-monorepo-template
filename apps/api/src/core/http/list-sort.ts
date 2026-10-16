import {
  type AnyColumn,
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import type { FilterField } from './list-query.js';

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
    ? (query) => sql`date_trunc('milliseconds', ${column(query)})`
    : sql`date_trunc('milliseconds', ${column})`;
};

/**
 * The key the rows hold a field's sort value under: its name, unless the
 * field sorts by another expression (`sort`: `lower(name)`), whose value
 * is selected next to the row under a key of its own, so the field's own
 * value stays what the client sees (`sortSelect`, `pick`).
 */
export const sortValueKey = (name: string, field: FilterField) =>
  field.sort ? `_sort_${name}` : name;

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

/** What a sorted cursor holds: its sort, the last row's sort values, and its id. */
interface CursorData {
  s: string;
  v: unknown[];
  id: string;
}

/** The cursor after `row` on a sorted list: opaque to clients (base64url JSON). */
export function encodeCursor(
  sort: readonly SortBy[],
  row: Record<string, unknown> & { id: string },
) {
  const data: CursorData = {
    s: sortKey(sort),
    v: sort.map(({ key }) => {
      const value = row[key];
      return value instanceof Date ? value.toISOString() : (value ?? null);
    }),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

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
 * The cursor of a sorted list, checked: made by this sort, with a value of
 * the right type per field. `undefined`: not one (a 400).
 */
export function decodeCursor(cursor: string, sort: readonly SortBy[]) {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    return undefined;
  }
  const parsed = z
    .object({
      s: z.literal(sortKey(sort)),
      v: z.tuple(
        sort.map((item) => cursorValue(item.type).nullable()) as unknown as [
          z.ZodType,
          ...z.ZodType[],
        ],
      ),
      id: z.uuid(),
    })
    .safeParse(data);
  return parsed.success
    ? { after: parsed.data.v as unknown[], id: parsed.data.id }
    : undefined;
}

/**
 * The rows after the cursor's row, in sortOrder then id descending:
 * (a > x) or (a = x and b > y) or … or (a = x and b = y and id < lastId),
 * with "after" turned by each direction and NULL the largest value.
 */
export function afterKeyset(
  sort: readonly SortBy[],
  after: readonly unknown[],
  id: AnyColumn,
  lastId: string,
  query: Record<string, unknown> = {},
): SQL | undefined {
  const terms: (SQL | undefined)[] = [];
  const equal: (SQL | undefined)[] = [];
  sort.forEach((item, index) => {
    const value = after[index];
    const column = columnOf(item.expression, query) as AnyColumn; // a column or SQL: both work
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
  return or(...terms);
}
