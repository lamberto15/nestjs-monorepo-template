import {
  type AnyColumn,
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notIlike,
  notInArray,
  or,
  is,
  SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { validationException } from './problem-details.filter.js';
import {
  columnOf,
  decodeCursor,
  type ListColumn,
  type SortBy,
  sortSchema,
} from './list-sort.js';
import {
  afterCursor,
  COUNT_CAP,
  type PageQuery,
  pageQuerySchema,
} from './pagination.js';

/**
 * What a filter may ask of a field: the same names in the flat syntax
 * (`?title.contains=x`) and in `?filter=` (`{"op":"contains"}`).
 */
export const FILTER_OPS = [
  'eq',
  'ne',
  'in',
  'notIn',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * A field of a list: its column, its type, the operators it may be filtered
 * with (`[]`: none), and whether it may be sorted by. `column` is a table's
 * column or any SQL expression of the row (`sql\`${t.custom}->>'region'\``),
 * so a value inside JSONB is declared like a column.
 */
export type FilterField = {
  column: ListColumn;
  ops: readonly FilterOp[];
  /**
   * `?sort=` may order by it (with an index on a large table). Its value
   * must be in the rows under the field's name: the cursor reads it there.
   */
  sortable?: boolean;
  /**
   * How an operator becomes SQL when the column's own comparison doesn't fit
   * (a JSON array: `in` means "holds any of"). Else the column is compared.
   */
  conditions?: Partial<Record<FilterOp, (value: unknown) => SQL>>;
  /**
   * How a sort value is read for the cursor when `column` is an expression
   * (selected under the field's name; see `sortSelect`): e.g. a number cast
   * back from text. Default: `column`.
   */
  select?: SQL;
  /**
   * What `?sort=` orders by when it isn't `column` itself: `lower(name)`
   * for an order that ignores case. Selected for the cursor under a key of
   * its own (`sortValueKey`; see `sortSelect`), never shown to clients.
   */
  sort?: ListColumn;
} & (
  | { type: 'string' | 'uuid' | 'datetime' | 'date' | 'number' | 'boolean' }
  | { type: 'enum'; values: readonly [string, ...string[]] }
);

/** At most this many conditions in a `filter`, and this many nested groups. */
export const MAX_CONDITIONS = 30;
export const MAX_DEPTH = 3;
/** At most this many values in `in`, `notIn`. */
const MAX_VALUES = 50;
const TEXT_OPS: readonly FilterOp[] = [
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
];

/** The query keys of a field: `status` (eq), `status.in`, `createdAt.gte`… */
const keyOf = (name: string, op: FilterOp) =>
  op === 'eq' ? name : `${name}.${op}`;

/** A value in the flat syntax: a query string. */
function textValue(field: FilterField): z.ZodType<unknown, string> {
  switch (field.type) {
    case 'uuid':
      return z.uuid();
    case 'datetime':
      return z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value));
    case 'date':
      // A calendar date (YYYY-MM-DD), compared as such: no time zone involved.
      return z.iso.date();
    case 'number':
      return z.coerce.number();
    case 'boolean':
      return z.enum(['true', 'false']).transform((value) => value === 'true');
    case 'enum':
      return z.enum(field.values);
    default:
      return z.string().min(1).max(200);
  }
}

/** A value in `filter`: JSON, so numbers and booleans are themselves. */
function jsonValue(field: FilterField): z.ZodType<unknown, unknown> {
  switch (field.type) {
    case 'uuid':
      return z.uuid();
    case 'datetime':
      return z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value));
    case 'date':
      // A calendar date (YYYY-MM-DD), compared as such: no time zone involved.
      return z.iso.date();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(field.values);
    default:
      return z.string().min(1).max(200);
  }
}

/** A comma-separated list of the flat syntax: trimmed, empty items dropped. */
const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/** What `?<name>.<op>=` takes. */
function flatSchema(field: FilterField, op: FilterOp): z.ZodType {
  if (op === 'isNull') {
    return z.enum(['true', 'false']).transform((value) => value === 'true');
  }
  if (op === 'in' || op === 'notIn') {
    // `status.in=draft,published`
    return commaList.pipe(z.array(textValue(field)).min(1).max(MAX_VALUES));
  }
  if (op === 'between') {
    // `createdAt.between=2026-01-01T00:00:00Z,2026-02-01T00:00:00Z`
    return commaList.pipe(z.tuple([textValue(field), textValue(field)]));
  }
  if (TEXT_OPS.includes(op)) {
    return z.string().min(1).max(200);
  }
  return textValue(field);
}

/** What `{ "op": <op>, "value": … }` takes in `filter`. */
function jsonSchema(field: FilterField, op: FilterOp): z.ZodType {
  if (op === 'isNull') {
    return z.boolean().default(true);
  }
  if (op === 'in' || op === 'notIn') {
    return z.array(jsonValue(field)).min(1).max(MAX_VALUES);
  }
  if (op === 'between') {
    return z.tuple([jsonValue(field), jsonValue(field)]);
  }
  if (TEXT_OPS.includes(op)) {
    return z.string().min(1).max(200);
  }
  return jsonValue(field);
}

/** `%` and `_` match anything in LIKE: a search for them means the characters. */
const escapeLike = (value: string) =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** One condition on a declared field, from a validated value. */
function condition(
  field: FilterField,
  op: FilterOp,
  value: unknown,
  query: Record<string, unknown> = {},
): SQL {
  const own = field.conditions?.[op];
  if (own) {
    return own(value);
  }
  // A column or an SQL expression: every operator takes both (their overloads don't take the union).
  const column = columnOf(field.column, query) as AnyColumn;
  switch (op) {
    case 'eq':
      return eq(column, value);
    case 'ne':
      return ne(column, value);
    case 'in':
      return inArray(column, value as unknown[]);
    case 'notIn':
      return notInArray(column, value as unknown[]);
    case 'contains':
      return ilike(column, `%${escapeLike(value as string)}%`);
    case 'notContains':
      return notIlike(column, `%${escapeLike(value as string)}%`);
    case 'startsWith':
      return ilike(column, `${escapeLike(value as string)}%`);
    case 'endsWith':
      return ilike(column, `%${escapeLike(value as string)}`);
    case 'gt':
      return gt(column, value);
    case 'gte':
      return gte(column, value);
    case 'lt':
      return lt(column, value);
    case 'lte':
      return lte(column, value);
    case 'between': {
      // Both ends included, as SQL's BETWEEN.
      const [from, to] = value as [unknown, unknown];
      return and(gte(column, from), lte(column, to))!;
    }
    case 'isNull':
      return value ? isNull(column) : isNotNull(column);
  }
}

type Issue = { path: (string | number)[]; message: string };

/**
 * `?filter=`: a JSON tree of conditions and groups,
 * `{"and":[{"field":"status","op":"in","value":["draft"]},{"or":[…]}]}`,
 * checked against the declared fields, into one SQL condition.
 */
function filterTreeSchema(fields: Record<string, FilterField>) {
  return z
    .string()
    .max(20_000)
    .transform((text, ctx): SQL | undefined => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'filter is not JSON' });
        return z.NEVER;
      }
      const issues: Issue[] = [];
      let conditions = 0;
      const node = (
        value: unknown,
        path: (string | number)[],
        depth: number,
      ): SQL | undefined => {
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          issues.push({
            path,
            message:
              'must be a condition { field, op, value } or a group { and: [] } / { or: [] }',
          });
          return undefined;
        }
        const keys = Object.keys(value);
        if (keys.length === 1 && (keys[0] === 'and' || keys[0] === 'or')) {
          const join = keys[0];
          const items = (value as Record<string, unknown>)[join];
          if (depth >= MAX_DEPTH) {
            issues.push({
              path,
              message: `groups nest at most ${MAX_DEPTH} deep`,
            });
            return undefined;
          }
          if (!Array.isArray(items) || items.length === 0) {
            issues.push({
              path: [...path, join],
              message: 'must be a non-empty array',
            });
            return undefined;
          }
          const parts = items.map((item, index) =>
            node(item, [...path, join, index], depth + 1),
          );
          return join === 'or' ? or(...parts) : and(...parts);
        }
        if (++conditions > MAX_CONDITIONS) {
          if (conditions === MAX_CONDITIONS + 1) {
            issues.push({
              path,
              message: `at most ${MAX_CONDITIONS} conditions`,
            });
          }
          return undefined;
        }
        const shape = z
          .object({
            field: z.string().min(1).max(100),
            op: z.enum(FILTER_OPS),
            value: z.unknown().optional(),
          })
          .strict()
          .safeParse(value);
        if (!shape.success) {
          for (const issue of shape.error.issues) {
            issues.push({
              path: [...path, ...(issue.path as (string | number)[])],
              message: issue.message,
            });
          }
          return undefined;
        }
        const { field: name, op } = shape.data;
        const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
        if (!field) {
          issues.push({
            path: [...path, 'field'],
            message: `Not a filter of this list: "${name}"`,
          });
          return undefined;
        }
        if (!field.ops.includes(op)) {
          issues.push({
            path: [...path, 'op'],
            message: `"${name}" can't be filtered with ${op}`,
          });
          return undefined;
        }
        const parsed = jsonSchema(field, op).safeParse(shape.data.value);
        if (!parsed.success) {
          issues.push({
            path: [...path, 'value'],
            message: `${name} ${op}: ${parsed.error.issues[0].message}`,
          });
          return undefined;
        }
        return condition(field, op, parsed.data);
      };
      const where = node(json, [], 0);
      for (const issue of issues) {
        ctx.addIssue({ code: 'custom', ...issue });
      }
      return issues.length ? z.NEVER : where;
    });
}

/** What a list declares besides its fields. */
export interface ListOptions {
  /**
   * The item fields `?fields=` may pick; `id` always comes. Usually the item
   * schema's keys: `Object.keys(noteSchema.shape)`.
   */
  select?: readonly string[];
  /**
   * The list's resource is soft-deletable: `?deleted=true` lists the
   * recycle bin (pass it to `access.sqlFilter(…, { deleted })`).
   */
  softDelete?: boolean;
}

const describeOps = (fields: Record<string, FilterField>) =>
  Object.entries(fields)
    .filter(([, field]) => field.ops.length)
    .map(([name, field]) => `${name} (${field.ops.join(', ')})`)
    .join('; ');

/**
 * The query of a list, the same everywhere: pagination, the filters the
 * list declares, its order and the fields to answer with
 * (docs/api-conventions.md).
 *
 * ```
 * ?status=draft                    flat filters: eq…
 * ?status.in=draft,published       one of (comma-separated)
 * ?title.contains=report           case-insensitive substring
 * ?createdAt.gte=2026-01-01T00:00:00Z&createdAt.lt=2026-02-01T00:00:00Z
 * ?publishedAt.isNull=true
 * ?filter={"or":[{"field":"status","op":"eq","value":"draft"},{"field":"title","op":"contains","value":"x"}]}
 * ?sort=-createdAt,title           declared sortable fields; id breaks ties
 * ?fields=title,status             only these (and id) in each item
 * ```
 *
 * Only declared fields, operators and sorts: anything else is a 400 naming
 * it, so callers can't filter or sort on columns that aren't meant for it
 * (or that have no index). Values are validated by type (dates, UUIDs,
 * enums). The flat filters and `filter` are ANDed; the caller's read
 * filter is ANDed outside all of it, so an `or` never widens what a caller
 * may see.
 *
 * ```ts
 * const NOTE_LIST = listQuery({
 *   status: { column: notes.status, type: 'enum', values: ['draft', 'published'], ops: ['eq', 'in'] },
 *   title: { column: notes.title, type: 'string', ops: ['contains'], sortable: true },
 * }, { select: Object.keys(noteSchema.shape) });
 * list(@Query({ schema: NOTE_LIST.schema }) query: ListQuery) {
 *   return this.notes.findPage(and(readFilter, NOTE_LIST.where(query)), query);
 * }
 * ```
 *
 * Fields known only at runtime (custom fields) join with `extend()`: a new
 * list with them, whose `schema` validates the request's query.
 */
export function listQuery(
  fields: Record<string, FilterField>,
  options: ListOptions = {},
) {
  const shape: Record<string, z.ZodType> = {
    ...pageQuerySchema.shape,
    // The language switch of @nestjs/i18n is allowed on every route.
    lang: z.string().max(35).optional(),
  };
  const keys: { key: string; name: string; op: FilterOp }[] = [];
  for (const [name, field] of Object.entries(fields)) {
    for (const op of field.ops) {
      const key = keyOf(name, op);
      keys.push({ key, name, op });
      shape[key] = flatSchema(field, op)
        .optional()
        .describe(`Filter: ${name} ${op === 'eq' ? '=' : op}`);
    }
  }

  const filterable = Object.entries(fields).filter(([, f]) => f.ops.length);
  if (filterable.length) {
    const [name, field] = filterable[0];
    shape.filter = filterTreeSchema(fields)
      .optional()
      .describe(
        `Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, ` +
          `${MAX_DEPTH} groups deep and ${MAX_CONDITIONS} conditions at most. ` +
          `Example: {"or":[{"field":"${name}","op":"${field.ops[0]}","value":…},{…}]}. ` +
          `Fields and operators: ${describeOps(fields)}.`,
      );
  }

  const sortable = Object.keys(fields).filter((name) => fields[name].sortable);
  if (sortable.length) {
    shape.sort = sortSchema(fields)
      .optional()
      .describe(
        `The order: fields comma-separated, - for descending; the newest first on ties. ` +
          `Example: -${sortable[0]}. Sortable: ${sortable.join(', ')}.`,
      );
  }

  const selectable = options.select ?? [];
  if (options.softDelete) {
    shape.deleted = z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true')
      .describe(
        'true: the recycle bin (deleted records), for those who may restore them.',
      );
  }
  if (selectable.length) {
    shape.fields = commaList
      .refine((names) => names.length > 0, { message: 'fields names no field' })
      .transform((names, ctx) => {
        const unknown = names.filter((name) => !selectable.includes(name));
        if (unknown.length) {
          ctx.addIssue({
            code: 'custom',
            message: `Not a field of this list: ${unknown.join(', ')}`,
          });
          return z.NEVER;
        }
        return [...new Set(names)];
      })
      .optional()
      .describe(
        `Only these fields in each item, comma-separated; id always comes. ` +
          `Example: ${selectable
            .filter((name) => name !== 'id')
            .slice(0, 2)
            .join(',')}. Fields: ${selectable.join(', ')}.`,
      );
  }

  const schema = z
    .object(shape)
    .strict()
    .superRefine((query, ctx) => {
      const cursor = query.cursor as string | undefined;
      const sort = query.sort as SortBy[] | undefined;
      const page = query.page as number | undefined;
      if (cursor !== undefined && page !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['cursor'],
          message: 'cursor and page are two ways to page: send one',
        });
      } else if (cursor !== undefined) {
        const valid = sort?.length
          ? decodeCursor(cursor, sort) !== undefined
          : z.uuid().safeParse(cursor).success;
        if (!valid) {
          ctx.addIssue({
            code: 'custom',
            path: ['cursor'],
            message: 'cursor is not the nextCursor of this list and sort',
          });
        }
      }
      if (
        page !== undefined &&
        (page - 1) * (query.limit as number) >= COUNT_CAP
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['page'],
          message: `page starts past row ${COUNT_CAP}: narrow the filters`,
        });
      }
    })
    // A sorted cursor carries the last row's sort values: `cursor` becomes its id, `after` the values.
    .overwrite((query) => {
      const sort = query.sort as SortBy[] | undefined;
      if (sort?.length && typeof query.cursor === 'string') {
        const decoded = decodeCursor(query.cursor, sort);
        if (decoded) {
          query.cursor = decoded.id;
          query.after = decoded.after;
        }
      }
      return query;
    });

  return {
    /** For `@Query({ schema })`: validates, converts and documents the query. */
    schema,
    /** The query parameters, one schema each (ApiListQuery documents them). */
    shape,
    /**
     * Validates a raw query (`@Query()` without a schema): for a list extended
     * per request (custom fields), which `@Query({ schema })` can't know.
     * Invalid: the same 400 as the validation pipe's.
     */
    parse(raw: unknown): ListQuery {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw validationException(result.error.issues);
      }
      return result.data as ListQuery;
    },
    /** The declared fields, to `extend()` or read. */
    fields,
    /** The filters of a validated query (flat ones and `filter`), and its cursor, as one SQL condition. */
    where(query: ListQuery, id?: AnyColumn): SQL | undefined {
      return and(
        ...keys
          .filter(({ key }) => query[key] !== undefined)
          .map(({ key, name, op }) =>
            condition(fields[name], op, query[key], query),
          ),
        query.filter as SQL | undefined,
        id ? afterCursor(id, query) : undefined,
      );
    },
    /**
     * The page with only the `?fields=` asked for (and `id`). Apply it last,
     * after redaction: field-level permissions read whole rows (a condition
     * may need a field that wasn't asked for), and what they hid stays hidden.
     */
    pick<P extends { items: object[] }>(page: P, query: ListQuery): P {
      const names = query.fields as string[] | undefined;
      // The sort values selected for the cursor (sortSelect) never reach the client.
      const sortOnly = Object.keys(this.sortSelect(query));
      if (!names && !sortOnly.length) {
        return page;
      }
      return {
        ...page,
        items: page.items.map((item) => {
          const rest = Object.fromEntries(
            Object.entries(item).filter(([key]) => !sortOnly.includes(key)),
          );
          return names ? pickFields(rest, names) : rest;
        }),
      };
    },
    /**
     * The sort values the cursor needs that aren't columns of the row (a field
     * whose column is an SQL expression): select them with the row under the
     * field's name, `select({ ...getTableColumns(t), ...list.sortSelect(q) })`.
     * `pick` removes them from the items.
     */
    sortSelect(query: ListQuery): Record<string, SQL.Aliased> {
      const sort = (query.sort as SortBy[] | undefined) ?? [];
      return Object.fromEntries(
        sort
          .filter(({ name }) => {
            const field = fields[name];
            const column = field?.column;
            return (
              !!field?.sort || typeof column === 'function' || is(column, SQL)
            );
          })
          .map(({ name, key }) => [
            key,
            (
              fields[name].select ??
              (columnOf(fields[name].sort ?? fields[name].column, query) as SQL)
            ).as(key),
          ]),
      );
    },
    /** This list with more fields (custom fields, per request) and more selectable ones. */
    extend(more: Record<string, FilterField>, select: readonly string[] = []) {
      return listQuery(
        { ...fields, ...more },
        { ...options, select: [...selectable, ...select] },
      );
    },
  };
}

/** A validated list query: the page, the sort, and the filter values by key. */
export type ListQuery = PageQuery & Record<string, unknown>;

/**
 * An item with only `names` (and `id`). A dotted name picks inside an object
 * field: `custom.region` keeps `{ custom: { region } }`.
 */
function pickFields(item: Record<string, unknown>, names: readonly string[]) {
  const picked: Record<string, unknown> = { id: item.id };
  for (const name of names) {
    const [head, ...rest] = name.split('.');
    if (!(head in item)) {
      continue;
    }
    if (!rest.length) {
      picked[head] = item[head];
      continue;
    }
    const inner = item[head];
    if (inner && typeof inner === 'object') {
      const key = rest.join('.');
      const target = (picked[head] ??= {}) as Record<string, unknown>;
      if (key in inner) {
        target[key] = (inner as Record<string, unknown>)[key];
      }
    }
  }
  return picked;
}

/** A declared list: what `listQuery()` returns. */
export type List = ReturnType<typeof listQuery>;
