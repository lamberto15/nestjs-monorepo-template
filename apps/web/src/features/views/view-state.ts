import type {
  ColumnFilterItem,
  FilterOperator,
  FilterVariant,
} from '@/lib/data-table-types';
import { formatFilterDate } from '@/lib/data-table-utils';

/**
 * A saved view's `params` (what the list route takes: GET /v1/views/{id}/apply)
 * turned back into the data table's state: the reverse of `listParams`
 * (lib/list-query.ts). A view saved from this table always maps; one made
 * through the API may hold a filter the table has no control for, which is
 * refused (UnshowableView) rather than shown wrong.
 */

export class UnshowableView extends Error {
  readonly what: string;
  constructor(what: string) {
    super(`The table cannot show ${what}`);
    this.what = what;
  }
}

/** What the table knows of a filterable column. */
export interface FilterColumn {
  variant: FilterVariant;
  operators: FilterOperator[];
  /** The list field's type (`datetime`, `date`…). */
  type: string;
}

export interface ViewContext {
  filterable: Record<string, FilterColumn>;
  sortable: ReadonlySet<string>;
  /** The operators the list lists for each field (to read `title.contains`). */
  fieldOperators: Record<string, readonly string[]>;
}

export interface ViewState {
  filters: ColumnFilterItem[];
  joinOperator: 'and' | 'or';
  sorting: { id: string; desc: boolean }[];
  q: string;
}

type Condition = { field: string; op: string; value: unknown };
type Tree = { and: Tree[] } | { or: Tree[] } | Condition;

const NOT_QUERY = new Set([
  'page',
  'limit',
  'cursor',
  'count',
  'fields',
  'deleted',
  'lang',
  'sort',
  'q',
  'filter',
]);

const TABLE_OPERATOR: Record<string, FilterOperator> = {
  contains: 'iLike',
  notContains: 'notILike',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  eq: 'eq',
  ne: 'ne',
  in: 'inArray',
  notIn: 'notInArray',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  between: 'isBetween',
};

const LISTS = new Set<FilterOperator>(['inArray', 'notInArray', 'isBetween']);

export function viewState(
  params: Record<string, string>,
  context: ViewContext,
): ViewState {
  const conditions: Condition[] = [];
  let joinOperator: 'and' | 'or' = 'and';
  let items: Tree[] = [];

  if (params.filter) {
    let tree: Tree;
    try {
      tree = JSON.parse(params.filter) as Tree;
    } catch {
      throw new UnshowableView('filter');
    }
    if ('or' in tree) joinOperator = 'or';
    items = 'and' in tree ? tree.and : 'or' in tree ? tree.or : [tree];
  }
  for (const [key, value] of Object.entries(params)) {
    if (NOT_QUERY.has(key)) continue;
    conditions.push(flatCondition(key, value, context));
  }
  // `filter` and the flat filters are ANDed by the API: an OR group cannot
  // take them along.
  if (conditions.length > 0 && joinOperator === 'or') {
    throw new UnshowableView(params.filter ?? 'filter');
  }

  const filters = [...items, ...conditions].map((node, index) =>
    toItem(node, context, index),
  );
  return {
    filters,
    joinOperator,
    sorting: sorting(params.sort, context),
    q: params.q ?? '',
  };
}

function sorting(sort: string | undefined, context: ViewContext) {
  if (!sort) return [];
  return sort.split(',').map((part) => {
    const desc = part.startsWith('-');
    const id = desc ? part.slice(1) : part;
    if (!context.sortable.has(id)) throw new UnshowableView(`sort ${part}`);
    return { id, desc };
  });
}

/** `status=draft`, `title.contains=x`, `custom.region.in=eu,us`. */
function flatCondition(
  key: string,
  value: string,
  context: ViewContext,
): Condition {
  if (key in context.fieldOperators) return { field: key, op: 'eq', value };
  const dot = key.lastIndexOf('.');
  const field = key.slice(0, dot);
  const op = key.slice(dot + 1);
  if (dot > 0 && context.fieldOperators[field]?.includes(op)) {
    if (op === 'in' || op === 'notIn') {
      return { field, op, value: value.split(',') };
    }
    if (op === 'between') return { field, op, value: value.split(',') };
    if (op === 'isNull') return { field, op, value: value === 'true' };
    return { field, op, value };
  }
  throw new UnshowableView(key);
}

const isCondition = (node: Tree): node is Condition => 'field' in node;
const isGroup = (node: Tree): node is { and: Tree[] } | { or: Tree[] } =>
  'and' in node || 'or' in node;

/** The local midnight an instant is, or undefined when it is not one. */
function midnight(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return local.getTime() === date.getTime() ? date : undefined;
}

const nextDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

function item(
  field: string,
  operator: FilterOperator,
  value: string | string[],
  column: FilterColumn,
  index: number,
): ColumnFilterItem {
  if (!column.operators.includes(operator)) {
    throw new UnshowableView(`${field} ${operator}`);
  }
  return {
    id: field,
    variant: column.variant,
    operator,
    value,
    filterId: `${field}-${index}`,
  };
}

function toItem(node: Tree, context: ViewContext, index: number) {
  if (isGroup(node)) return dayPair(node, context, index);
  const column = context.filterable[node.field];
  if (!column) throw new UnshowableView(node.field);
  const { field, op, value } = node;

  if (op === 'isNull') {
    return item(field, value ? 'isEmpty' : 'isNotEmpty', '', column, index);
  }
  let operator = TABLE_OPERATOR[op];
  if (!operator) throw new UnshowableView(`${field} ${op}`);
  if (column.type === 'datetime') return dateTime(node, column, index);

  let values: string | string[] = Array.isArray(value)
    ? value.map(String)
    : String(value);
  // A multi-select has only `in`: an `eq` on it is a list of one.
  if (
    operator === 'eq' &&
    !column.operators.includes('eq') &&
    column.operators.includes('inArray')
  ) {
    operator = 'inArray';
  }
  if (LISTS.has(operator) && !Array.isArray(values)) values = [values];
  if (!LISTS.has(operator) && Array.isArray(values)) {
    throw new UnshowableView(`${field} ${op}`);
  }
  return item(field, operator, values, column, index);
}

/** A datetime filtered by the table is a range of instants (dateCondition). */
function dateTime(node: Condition, column: FilterColumn, index: number) {
  const { field, op, value } = node;
  const day = (instant: unknown) => {
    const date = midnight(instant);
    if (!date) throw new UnshowableView(`${field} ${op}`);
    return formatFilterDate(date);
  };
  switch (op) {
    case 'lt':
      return item(field, 'lt', day(value), column, index);
    case 'gte':
      return item(field, 'gte', day(value), column, index);
    case 'between': {
      const [from, to] = Array.isArray(value) ? value : [];
      // The last day ends 1 ms before the next one.
      const next =
        typeof to === 'string'
          ? midnight(new Date(Date.parse(to) + 1).toISOString())
          : undefined;
      if (!next) throw new UnshowableView(`${field} ${op}`);
      return item(
        field,
        'isBetween',
        [day(from), formatFilterDate(new Date(next.getTime() - 1))],
        column,
        index,
      );
    }
    default:
      throw new UnshowableView(`${field} ${op}`);
  }
}

/** `eq`/`ne` on a datetime day: and[gte, lt] / or[lt, gte] of one field. */
function dayPair(
  node: { and: Tree[] } | { or: Tree[] },
  context: ViewContext,
  index: number,
) {
  const [first, second, ...rest] = 'and' in node ? node.and : node.or;
  if (
    first &&
    second &&
    rest.length === 0 &&
    isCondition(first) &&
    isCondition(second) &&
    first.field === second.field
  ) {
    const column = context.filterable[first.field];
    const gte = first.op === 'gte' ? first : second;
    const lt = first.op === 'lt' ? first : second;
    // eq: gte the day and lt the next; ne: lt the day or gte the next.
    const [dayStart, dayEnd] =
      'and' in node ? [gte.value, lt.value] : [lt.value, gte.value];
    const from = midnight(dayStart);
    const to = midnight(dayEnd);
    if (
      column?.type === 'datetime' &&
      gte.op === 'gte' &&
      lt.op === 'lt' &&
      from &&
      to &&
      nextDay(from).getTime() === to.getTime()
    ) {
      return item(
        first.field,
        'and' in node ? 'eq' : 'ne',
        formatFilterDate(from),
        column,
        index,
      );
    }
  }
  throw new UnshowableView('a nested filter');
}
