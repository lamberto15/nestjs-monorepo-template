import {
  filterParam,
  sortParam,
  unwrap,
  type Filter,
  type FilterCondition,
  type FilterOperator as ApiOperator,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import {
  keepPreviousData,
  useQuery,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ColumnDef, RowData } from '@tanstack/react-table';
import {
  parseAsInteger,
  parseAsString,
  useQueryState,
  useQueryStates,
} from 'nuqs';
import { useCallback, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import type { DataTableFeatures } from '@/lib/data-table-features';
import {
  getColumnFilterParser,
  getColumnFilters,
  getSortingStateParser,
} from '@/lib/data-table-parsers';
import type {
  ColumnFilterItem,
  FilterOperator,
  FilterOption,
  FilterVariant,
  JoinOperator,
  OptionSearch,
} from '@/lib/data-table-types';
import { getActiveFilters, parseFilterDate } from '@/lib/data-table-utils';
import type { RefSources } from '@/lib/list-refs';
import { recordKeys } from '@/lib/records';

/**
 * GET /v1/lists/{subject} turned into what a data table needs, and the
 * data-table state (the URL, through nuqs) turned into the list route's
 * query (docs/api-conventions.md, "Using it from a data table"). Custom code
 * because the registry has no server mode for this API's filters; the
 * mapping is the one that doc describes.
 */

export type ListDescription = GetResponse<'/v1/lists/{subject}'>;
export type ListField = ListDescription['fields'][number];
export type ListColumn<TData extends RowData> = ColumnDef<
  DataTableFeatures,
  TData
>;

/** The paths whose GET pages by number: `{ items, pageCount }`. */
export type ListPath = {
  [P in keyof paths]: GetResponse<P> extends {
    items: unknown[];
    pageCount?: number;
  }
    ? P
    : never;
}[keyof paths];

export type ListRow<P extends ListPath> =
  GetResponse<P> extends { items: (infer R extends RowData)[] } ? R : never;

/** What a list route answers with, page by number. */
export interface ListPageData<TRow> {
  items: TRow[];
  page?: number;
  nextPage?: number | null;
  pageCount?: number;
  total?: number;
  totalCapped?: boolean;
}

export const DEFAULT_PER_PAGE = 20;
export const SEARCH_KEY = 'q';

// ---------------------------------------------------------------- metadata

export interface FilterSpec {
  variant: FilterVariant;
  /** The registry's operators this field's API operators can express. */
  operators: FilterOperator[];
  options?: FilterOption[];
  /** The API searches the options as one types (users). */
  search?: OptionSearch;
}

/**
 * The filter menu's variant and operators for a field, from the operators the
 * API lists for it; undefined when it can't be filtered (sort only), or only
 * with operators the menu has no equivalent for.
 * The menu's "relative to today" is never offered: the API has no such operator.
 */
export function filterSpec(
  field: ListField,
  refs: RefSources = {},
): FilterSpec | undefined {
  const has = new Set<ApiOperator>(field.operators);
  const operators: FilterOperator[] = [];
  const add = (condition: boolean, operator: FilterOperator) => {
    if (condition) operators.push(operator);
  };
  const empty = () => {
    add(has.has('isNull'), 'isEmpty');
    add(has.has('isNull'), 'isNotEmpty');
  };
  let variant: FilterVariant;
  let options: FilterOption[] | undefined;

  const source = field.ref ? refs[field.ref] : undefined;
  if (source) {
    // A picker of what the field points at (tags, units, users): `in` takes
    // several, `eq` one; the id (or key) is the value.
    const multiple = has.has('in');
    if (multiple) {
      add(true, 'inArray');
      add(has.has('notIn'), 'notInArray');
    } else {
      add(has.has('eq'), 'eq');
      add(has.has('ne'), 'ne');
    }
    empty();
    return operators.length > 0
      ? {
          variant: multiple ? 'multiSelect' : 'select',
          operators,
          options: source.options,
          ...(source.search && { search: source.search }),
        }
      : undefined;
  }

  switch (field.type) {
    case 'enum':
      options = (field.options ?? []).map((value) => ({
        label: value,
        value,
      }));
      if (has.has('in')) {
        variant = 'multiSelect';
        add(true, 'inArray');
        add(has.has('notIn'), 'notInArray');
      } else {
        variant = 'select';
        add(has.has('eq'), 'eq');
        add(has.has('ne'), 'ne');
      }
      empty();
      break;
    case 'number':
      variant = 'number';
      for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const) {
        add(has.has(op), op);
      }
      add(has.has('between'), 'isBetween');
      empty();
      break;
    case 'datetime':
    case 'date': {
      variant = 'date';
      // A datetime filtered by a day is a range of instants (dateCondition).
      const day = field.type === 'datetime';
      add(day ? has.has('gte') && has.has('lt') : has.has('eq'), 'eq');
      add(day ? has.has('gte') && has.has('lt') : has.has('ne'), 'ne');
      add(has.has('lt'), 'lt');
      add(day ? has.has('lt') || has.has('lte') : has.has('lte'), 'lte');
      add(day ? has.has('gte') || has.has('gt') : has.has('gt'), 'gt');
      add(has.has('gte'), 'gte');
      add(has.has('between'), 'isBetween');
      empty();
      break;
    }
    case 'boolean':
      variant = 'boolean';
      add(has.has('eq'), 'eq');
      add(has.has('ne'), 'ne');
      break;
    default:
      variant = 'text';
      add(has.has('contains'), 'iLike');
      add(has.has('notContains'), 'notILike');
      add(has.has('eq'), 'eq');
      add(has.has('ne'), 'ne');
      add(has.has('startsWith'), 'startsWith');
      add(has.has('endsWith'), 'endsWith');
      empty();
  }
  return operators.length > 0
    ? { variant, operators, ...(options && { options }) }
    : undefined;
}

/**
 * The caller's columns (cells, headers) completed from the list's metadata:
 * which are filterable (variant, operators, options) and sortable. A column
 * the list doesn't know is neither. `meta.label` stays the caller's. A
 * reference field's options come from `refs` (useListRefs).
 */
export function withListMeta<TData extends RowData>(
  columns: ListColumn<TData>[],
  description: ListDescription,
  refs?: RefSources,
): ListColumn<TData>[] {
  const fields = new Map(description.fields.map((f) => [f.name, f]));
  return columns.map((column) => {
    const field = column.id ? fields.get(column.id) : undefined;
    const spec = field && filterSpec(field, refs);
    return {
      ...column,
      enableSorting: field?.sortable ?? false,
      enableColumnFilter: spec !== undefined,
      meta: {
        ...column.meta,
        ...(field?.label && !column.meta?.label && { label: field.label }),
        ...(spec && {
          variant: spec.variant,
          operators: spec.operators,
          ...(spec.options && { options: spec.options }),
          ...(spec.search && { search: spec.search }),
        }),
      },
    } as ListColumn<TData>;
  });
}

/** `-createdAt` (the list's defaultSort) as the table's sorting state. */
export function defaultSorting(description: ListDescription) {
  return description.defaultSort
    ? [
        {
          id: description.defaultSort.replace(/^-/, ''),
          desc: description.defaultSort.startsWith('-'),
        },
      ]
    : [];
}

// ------------------------------------------------------------------- state

export interface ListState {
  page: number;
  perPage: number;
  sorting: { id: string; desc: boolean }[];
  filters: ColumnFilterItem[];
  joinOperator: JoinOperator;
  /** The visible columns; left out: all fields. */
  fields?: string[];
  q?: string;
}

function startOfDay(value: string): Date | undefined {
  const date = parseFilterDate(value);
  if (!date) return undefined;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function nextDay(date: Date): Date {
  // Calendar arithmetic, not +24h, so a DST change doesn't shift it.
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

function ymd(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** A day the user picked is their local day, as instants (docs/api-conventions.md). */
function dateCondition(
  field: string,
  operator: FilterOperator,
  value: string | string[],
  type: ListField['type'],
): Filter | undefined {
  const first = startOfDay(Array.isArray(value) ? (value[0] ?? '') : value);
  if (!first) return undefined;
  const last = startOfDay(Array.isArray(value) ? (value[1] ?? '') : '');
  const cond = (op: FilterCondition['op'], v: string | string[]): Filter => ({
    field,
    op,
    value: v,
  });

  if (type === 'date') {
    // A calendar date, no time: compared as YYYY-MM-DD.
    if (operator === 'isBetween') {
      return last ? cond('between', [ymd(first), ymd(last)]) : undefined;
    }
    const direct = {
      eq: 'eq',
      ne: 'ne',
      lt: 'lt',
      lte: 'lte',
      gt: 'gt',
      gte: 'gte',
    } as const;
    const op = direct[operator as keyof typeof direct];
    return op ? cond(op, ymd(first)) : undefined;
  }

  const from = first.toISOString();
  const to = nextDay(first).toISOString();
  switch (operator) {
    case 'eq':
      return { and: [cond('gte', from), cond('lt', to)] };
    case 'ne':
      return { or: [cond('lt', from), cond('gte', to)] };
    case 'lt':
      return cond('lt', from);
    case 'lte':
      return cond('lt', to);
    case 'gt':
      return cond('gte', to);
    case 'gte':
      return cond('gte', from);
    case 'isBetween':
      // `between` includes both ends: the last day ends 1 ms before the next.
      return last
        ? cond('between', [
            from,
            new Date(nextDay(last).getTime() - 1).toISOString(),
          ])
        : undefined;
    default:
      return undefined;
  }
}

const SIMPLE: Partial<Record<FilterOperator, ApiOperator>> = {
  iLike: 'contains',
  notILike: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  eq: 'eq',
  ne: 'ne',
  inArray: 'in',
  notInArray: 'notIn',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  isBetween: 'between',
};

/** One filter item as an API condition; undefined when it can't be one. */
export function toCondition(
  item: ColumnFilterItem,
  type: ListField['type'] = 'string',
): Filter | undefined {
  const { id: field, operator, value, variant } = item;
  if (operator === 'isEmpty') return { field, op: 'isNull', value: true };
  if (operator === 'isNotEmpty') return { field, op: 'isNull', value: false };

  if (variant === 'date' || variant === 'dateRange') {
    return dateCondition(field, operator, value, type);
  }
  const op = SIMPLE[operator];
  if (!op) return undefined; // isRelativeToToday: the API has no such thing
  const list = Array.isArray(value) ? value : [value];

  if (variant === 'number' || variant === 'range') {
    const numbers = list.map((v) => (v === '' ? Number.NaN : Number(v)));
    if (numbers.some(Number.isNaN)) return undefined;
    return {
      field,
      op,
      value: op === 'between' ? numbers : (numbers[0] as number),
    };
  }
  if (variant === 'boolean') {
    return { field, op, value: list[0] === 'true' };
  }
  if (op === 'in' || op === 'notIn' || op === 'between') {
    return { field, op, value: list };
  }
  return { field, op, value: list[0] ?? '' };
}

/** The list route's query for a data-table state. */
export function listParams(
  state: ListState,
  fields: readonly ListField[],
): Record<string, string> {
  const types = new Map(fields.map((f) => [f.name, f.type]));
  const conditions = getActiveFilters(state.filters)
    .map((item) => toCondition(item, types.get(item.id)))
    .filter((c): c is Filter => c !== undefined);

  const params: Record<string, string> = {
    page: String(state.page),
    limit: String(state.perPage),
    count: 'true',
  };
  if (state.sorting.length > 0) {
    params.sort = sortParam(
      ...state.sorting.map((s) => (s.desc ? '-' : '') + s.id),
    );
  }
  if (state.fields && state.fields.length > 0) {
    params.fields = state.fields.join(',');
  }
  if (conditions.length > 0) {
    params.filter = filterParam(
      state.joinOperator === 'or' ? { or: conditions } : { and: conditions },
    );
  }
  if (state.q) params.q = state.q;
  return params;
}

// ------------------------------------------------------------------- hooks

/** The list's metadata, fetched once: it changes with permissions and custom fields only. */
export function useListDescription(subject: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['lists', subject],
    queryFn: () =>
      unwrap(api.GET('/v1/lists/{subject}', { params: { path: { subject } } })),
    staleTime: 10 * 60 * 1000,
  });
}

/**
 * The page and its size within what the list route serves (the description's
 * `limits`): a `limit` outside 1..maxLimit, a page below 1 or one starting at
 * or past row maxOffset is a 400 (`?page=0`, `?perPage=500`, page 999).
 */
function withinLimits(
  page: number,
  perPage: number,
  limits: Partial<ListDescription['limits']>,
) {
  const size =
    perPage < 1
      ? DEFAULT_PER_PAGE
      : Math.min(perPage, limits.maxLimit ?? perPage);
  const last = limits.maxOffset
    ? Math.max(1, Math.ceil(limits.maxOffset / size))
    : page;
  return { page: Math.min(Math.max(1, page), last), perPage: size };
}

export async function fetchPage<P extends ListPath>(
  path: P,
  query: Record<string, string>,
  pathParams?: Record<string, string>,
): Promise<ListPageData<ListRow<P>>> {
  // openapi-fetch types its query per path; this one is generic over paths.
  const get = api.GET as unknown as (
    path: string,
    init: {
      params: { query: Record<string, string>; path?: Record<string, string> };
    },
  ) => Promise<{ data?: ListPageData<ListRow<P>>; response: Response }>;
  return unwrap(
    get(path, {
      params: { query, ...(pathParams && { path: pathParams }) },
    }),
  );
}

/** What a list route may ask besides the table's state. */
export interface ListQueryOptions<TRow> {
  /** More parameters of the route, such as `deleted=true` (the recycle bin). */
  extra?: Record<string, string>;
  /** The values of the route's `{placeholders}` (`{ clientId }`). */
  pathParams?: Record<string, string>;
  /**
   * Ask again after this many ms (false: never), given the rows shown: for a
   * list whose rows settle on their own, such as deliveries in flight.
   */
  refetchInterval?: (rows: TRow[]) => number | false;
}

/**
 * The page of a list for the data table's URL state (the same nuqs keys
 * `useDataTable` writes: page, perPage, sort, joinOperator, one per filtered
 * column, and `q`), with the previous page kept while the next one loads.
 * `columns` are those from `withListMeta`; `fields` the visible ones.
 */
export function useListQuery<P extends ListPath>(
  path: P,
  description: ListDescription,
  columns: ListColumn<ListRow<P>>[],
  fields?: string[],
  options: ListQueryOptions<ListRow<P>> = {},
) {
  const { extra, pathParams, refetchInterval } = options;
  const sortableIds = useMemo(
    () =>
      columns.flatMap((c) => (c.id && c.enableSorting !== false ? [c.id] : [])),
    [columns],
  );
  const filterable = useMemo(
    () =>
      columns.flatMap((c) =>
        c.id && c.enableColumnFilter
          ? [[c.id, c.meta?.variant ?? 'text'] as const]
          : [],
      ),
    [columns],
  );
  const filterIds = useMemo(() => filterable.map(([id]) => id), [filterable]);

  const [urlPage, setPage] = useQueryState(
    'page',
    parseAsInteger.withDefault(1),
  );
  const [urlPerPage, setPerPage] = useQueryState(
    'perPage',
    parseAsInteger.withDefault(DEFAULT_PER_PAGE),
  );
  const { page, perPage } = withinLimits(
    urlPage,
    urlPerPage,
    description.limits,
  );
  // The URL says so too: the table's pager reads the same keys (useDataTable).
  useEffect(() => {
    if (urlPage !== page) {
      void setPage(page === 1 ? null : page);
    }
    if (urlPerPage !== perPage) {
      void setPerPage(perPage === DEFAULT_PER_PAGE ? null : perPage);
    }
  }, [urlPage, page, urlPerPage, perPage, setPage, setPerPage]);
  const [sorting] = useQueryState(
    'sort',
    getSortingStateParser(sortableIds).withDefault(defaultSorting(description)),
  );
  const [joinOperator] = useQueryState(
    'joinOperator',
    parseAsString.withDefault('and'),
  );
  const [filterParams] = useQueryStates(
    Object.fromEntries(
      filterable.map(([id, variant]) => [
        id,
        getColumnFilterParser(id, variant),
      ]),
    ),
  );
  const [q, setQ] = useQueryState(
    SEARCH_KEY,
    parseAsString.withDefault('').withOptions({ throttleMs: 300 }),
  );

  const filters = useMemo(
    () => getColumnFilters(filterIds, (id) => filterParams[id] ?? []),
    [filterIds, filterParams],
  );

  const selectable = useMemo(() => new Set(description.select), [description]);
  const params = useMemo(
    () => ({
      ...listParams(
        {
          page,
          perPage,
          sorting,
          filters,
          joinOperator: joinOperator === 'or' ? 'or' : 'and',
          fields: fields?.filter((f) => selectable.has(f)),
          q: description.search ? q : '',
        },
        description.fields,
      ),
      ...extra,
    }),
    [
      page,
      perPage,
      sorting,
      filters,
      joinOperator,
      fields,
      selectable,
      q,
      description,
      extra,
    ],
  );

  const result: UseQueryResult<ListPageData<ListRow<P>>> = useQuery({
    queryKey: recordKeys.list(path, params, pathParams),
    queryFn: () => fetchPage(path, params, pathParams),
    placeholderData: keepPreviousData,
    refetchInterval: refetchInterval
      ? (query) => refetchInterval(query.state.data?.items ?? [])
      : false,
  });

  // A page with nothing on it past the first (a stale ?page=, the last row of
  // the last page deleted): the last page there is, so the pager stays
  // reachable rather than "nothing here" (as features/suppressions does).
  const pageCount = result.data?.pageCount;
  const stranded =
    page > 1 &&
    !result.isPlaceholderData &&
    result.data !== undefined &&
    result.data.items.length === 0;
  useEffect(() => {
    if (stranded) {
      const last = Math.min(page - 1, Math.max(1, pageCount ?? 1));
      void setPage(last <= 1 ? null : last);
    }
  }, [stranded, page, pageCount, setPage]);

  const search = useCallback(
    (value: string) => {
      void setPage(1);
      void setQ(value || null);
    },
    [setPage, setQ],
  );

  return { ...result, params, q, search };
}

/**
 * The part of a list's query that says WHICH records: the advanced `filter`
 * and the search `q`, as the list route and the export, bulk and report
 * routes (which take the list's own filters) read them. Page, sort and
 * fields say how to show them and are left out (a bulk run takes no order;
 * an export takes the sort apart: `listExport`).
 */
export function listFilters(
  params: Record<string, string>,
): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const key of ['filter', 'q']) {
    const value = params[key];
    if (value) filters[key] = value;
  }
  return filters;
}

/**
 * What an export (or a scheduled report) takes of a list so that its file
 * holds exactly what the list shows, in the order shown: the list's
 * `filter` and `q`, the page's own fixed scope (`extra`: flat filters on the
 * list's fields; route options such as `include` are no filters and are
 * left out), and the `sort`. The columns are the exporter's, so `fields`
 * and the page are not sent.
 */
export function listExport(
  params: Record<string, string>,
  extra: Record<string, string> | undefined,
  fields: readonly ListField[],
): { filters: Record<string, string>; sort?: string } {
  const scope = Object.entries(extra ?? {}).filter(([key]) =>
    fields.some((f) => key === f.name || key.startsWith(`${f.name}.`)),
  );
  return {
    filters: { ...Object.fromEntries(scope), ...listFilters(params) },
    ...(params.sort && { sort: params.sort }),
  };
}
