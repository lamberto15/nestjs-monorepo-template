import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Subscribe,
  type ReactTable,
  type RowData,
} from '@tanstack/react-table';
import { useRouter } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable } from '@/components/data-table/data-table';
import { getDataTableActionsColumn } from '@/components/data-table/data-table-actions-column';
import { DataTableAdvancedToolbar } from '@/components/data-table/data-table-advanced-toolbar';
import { getDataTableSelectColumn } from '@/components/data-table/data-table-select-column';
import { DataTableFilterMenu } from '@/components/data-table/data-table-filter-menu';
import { DataTableSkeleton } from '@/components/data-table/data-table-skeleton';
import { DataTableSortMenu } from '@/components/data-table/data-table-sort-menu';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { ListBulkBar } from '@/components/list-bulk-bar';
import { ViewsPicker } from '@/features/views/views-picker';
import type { BulkContext } from '@/features/bulk/types';
import { useDataTable } from '@/hooks/use-data-table';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';
import { customFieldColumns, refColumns } from '@/lib/list-columns';
import { useListRefs } from '@/lib/list-refs';
import type { DataTableFeatures } from '@/lib/data-table-features';
import {
  DEFAULT_PER_PAGE,
  defaultSorting,
  listFilters,
  useListDescription,
  useListQuery,
  withListMeta,
  type ListColumn,
  type ListDescription,
  type ListPath,
  type ListRow,
} from '@/lib/list-query';

export interface ListPageProps<P extends ListPath> {
  /** The subject of GET /v1/lists/{subject} (`Invoice`). */
  subject: string;
  /** The list route (`/v1/<plural>`). */
  path: P;
  /** Cells and headers; filters and sorting come from the list's metadata. */
  columns: ListColumn<ListRow<P>>[];
  /** The heading above the table. */
  title: string;
  /** A line under the heading. */
  subtitle?: string;
  /** The heading's level: 2 when the list sits under a page's own `h1`. */
  headingLevel?: 1 | 2;
  /** Buttons beside the heading: "New", a recycle-bin toggle. */
  toolbarActions?: ReactNode;
  /** More query parameters of the list route (`{ deleted: 'true' }`: the bin). */
  query?: Record<string, string>;
  /**
   * The values of the route's `{placeholders}` (`{ clientId }`), for a list
   * under a parent: the path stays the template, they fill it.
   */
  pathParams?: Record<string, string>;
  /**
   * Ask the list again after this many ms (false: never), given the rows
   * shown: for rows that settle on their own. Keep it stable.
   */
  refetchInterval?: (rows: ListRow<P>[]) => number | false;
  /** Where a click on a row goes (a link inside the row keeps its own). */
  rowHref?: (row: ListRow<P>) => string;
  /**
   * The items of a row's actions menu (DropdownMenuItem…), as a last column.
   * Keep it stable (useCallback) so the table is not rebuilt.
   */
  rowActions?: (row: ListRow<P>) => ReactNode;
  /**
   * Buttons in the table's toolbar that act on the list as it is shown: an
   * export gets the current `params` (filter, search…). Keep it stable.
   */
  listActions?: (context: { params: Record<string, string> }) => ReactNode;
  /** A checkbox column: rows can be selected (the pagination counts them). */
  selectable?: boolean;
  /**
   * The action bar of a selection (implies `selectable`): what it renders in
   * the bar for the chosen rows (`ActionBarItem`s, see features/bulk).
   * The selection is cleared when the list's filter or search changes.
   */
  bulkActions?: (context: BulkContext) => ReactNode;
  /** Ask for every field of the route, not only the visible columns. */
  allFields?: boolean;
}

/**
 * A server-paginated, filterable, sortable list of any subject: the table's
 * state is in the URL (nuqs), the page comes from the API (TanStack Query).
 */
export function ListPage<P extends ListPath>(props: ListPageProps<P>) {
  const description = useListDescription(props.subject);
  const { t } = useTranslation();

  return (
    <Page>
      <PageHeader
        title={props.title}
        description={props.subtitle}
        actions={props.toolbarActions}
        level={props.headingLevel}
      />
      {description.isPending ? (
        <DataTableSkeleton columnCount={props.columns.length} />
      ) : description.isError ? (
        <ErrorState error={description.error} onRetry={description.refetch} />
      ) : (
        <ListTable {...props} description={description.data} />
      )}
      <span className="sr-only" aria-live="polite">
        {description.isPending ? t('list.loading') : ''}
      </span>
    </Page>
  );
}

function ListTable<P extends ListPath>({
  subject,
  path,
  columns,
  description,
  query: extraQuery,
  pathParams,
  refetchInterval,
  rowHref,
  rowActions,
  listActions,
  selectable,
  bulkActions,
  allFields,
}: ListPageProps<P> & { description: ListDescription }) {
  const { t, i18n } = useTranslation();
  const router = useRouter({ warn: false });
  const checkable = selectable || bulkActions !== undefined;
  // What the reference fields point at: tags, units, users (`ref`).
  const refs = useListRefs(subject, description.fields);
  // The caller's columns, then what the list's metadata adds to them: the
  // reference fields (by name; a filter-only one like `tag` never shown)
  // and the custom fields, hidden at first.
  const { cols, hidden } = useMemo(() => {
    const declared = new Set(columns.map((c) => c.id));
    const extra = [
      ...refColumns<ListRow<P>>(description, refs, t),
      ...customFieldColumns<ListRow<P>>(description, i18n.language, t),
    ].filter((c) => !declared.has(c.id));
    const withMeta = withListMeta([...columns, ...extra], description, refs);
    const withActions = rowActions
      ? [
          ...withMeta,
          getDataTableActionsColumn<ListRow<P>>({
            actions: ({ row }) => rowActions(row.original),
          }),
        ]
      : withMeta;
    return {
      cols: checkable
        ? [getDataTableSelectColumn<ListRow<P>>(), ...withActions]
        : withActions,
      hidden: Object.fromEntries(
        extra.flatMap((c) => (c.id ? [[c.id, false]] : [])),
      ),
    };
  }, [columns, description, refs, t, i18n.language, rowActions, checkable]);
  const [fields, setFields] = useState(() =>
    cols.flatMap((c) => (c.id && !(c.id in hidden) ? [c.id] : [])),
  );
  const query = useListQuery(path, description, cols, fields, {
    extra: extraQuery,
    pathParams,
    refetchInterval,
    allFields,
  });

  const { table } = useDataTable({
    data: query.data?.items ?? EMPTY,
    columns: cols,
    pageCount: query.data?.pageCount ?? 1,
    initialState: {
      sorting: defaultSorting(description),
      pagination: { pageIndex: 0, pageSize: DEFAULT_PER_PAGE },
      columnVisibility: hidden,
    },
    getRowId: (row) => (row as { id: string }).id,
  });

  // A selection is of the rows of THIS filter: another one starts again.
  // `table` changes identity on every parent render, so compare the scope
  // itself, or opening a bulk dialog would clear the selection (#763).
  const scope = JSON.stringify([listFilters(query.params), extraQuery]);
  const selectedScope = useRef(scope);
  useEffect(() => {
    if (selectedScope.current === scope) return;
    selectedScope.current = scope;
    table.setRowSelection({});
  }, [scope, table]);

  const filtered = 'filter' in query.params || 'q' in query.params;
  const empty = query.isSuccess && query.data.items.length === 0 && !filtered;

  return (
    <div className="flex flex-col gap-2">
      <FieldsSync table={table} onChange={setFields} />
      <DataTableAdvancedToolbar table={table}>
        {description.search && (
          <SearchBox value={query.q} onSearch={query.search} />
        )}
        <ViewsPicker
          subject={subject}
          description={description}
          table={table}
          params={query.params}
          // Applying a saved view sets the search; the box follows `q`.
          onSearch={query.search}
        />
        <DataTableFilterMenu table={table} />
        <DataTableSortMenu table={table} />
        {listActions?.({ params: query.params })}
      </DataTableAdvancedToolbar>
      {query.isError ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : query.isPending ? (
        <DataTableSkeleton columnCount={cols.length} withViewOptions={false} />
      ) : empty ? (
        <EmptyState
          title={t('list.empty.title')}
          description={t('list.empty.description')}
        />
      ) : (
        <DataTable
          table={table}
          aria-busy={query.isPlaceholderData}
          onRowClick={
            rowHref
              ? (row) => router?.history.push(rowHref(row as ListRow<P>))
              : undefined
          }
          className={query.isPlaceholderData ? 'opacity-60' : undefined}
          actionBar={
            bulkActions ? (
              <ListBulkBar
                table={table}
                total={query.data?.total}
                filter={listFilters(query.params)}
                actions={bulkActions}
              />
            ) : undefined
          }
        />
      )}
    </div>
  );
}

const EMPTY: never[] = [];

/**
 * Reports the visible columns, which become `fields=` of the query. Only a
 * change reports, so the first page is fetched once.
 */
function FieldsSync<TData extends RowData>({
  table,
  onChange,
}: {
  table: ReactTable<DataTableFeatures, TData, unknown>;
  onChange: (fields: string[]) => void;
}) {
  return (
    <Subscribe source={table.atoms.columnVisibility}>
      {(visibility) => (
        <FieldsReport
          ids={table
            .getAllLeafColumns()
            .filter((c) => visibility[c.id] !== false)
            .map((c) => c.id)}
          onChange={onChange}
        />
      )}
    </Subscribe>
  );
}

function FieldsReport({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (fields: string[]) => void;
}) {
  const key = ids.join(',');
  useEffect(() => {
    onChange(key ? key.split(',') : []);
  }, [key, onChange]);
  return null;
}

/** How long the typing pauses before the list is asked (one request, not one a key). */
const SEARCH_DEBOUNCE_MS = 250;

function SearchBox(props: { value: string; onSearch: (q: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(props.value);
  // The `q` this box last saw, and the one it last asked for. A `q` that
  // changes to anything else came from outside (the sidebar's link to the
  // bare list, back and forward): the box shows it. Its own search, which
  // lags the typing by the debounce, never overwrites what was typed since.
  const [seen, setSeen] = useState(props.value);
  const [sent, setSent] = useState(props.value);
  if (props.value !== seen) {
    setSeen(props.value);
    if (props.value !== sent) {
      setSent(props.value);
      setValue(props.value);
    }
  }
  const search = useDebouncedCallback((q: string) => {
    setSent(q);
    props.onSearch(q);
  }, SEARCH_DEBOUNCE_MS);
  return (
    <div className="relative w-full sm:w-auto">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={t('list.search')}
        placeholder={t('list.search')}
        className="h-8 w-full ps-8 sm:w-48 lg:w-64"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          search(event.target.value);
        }}
      />
    </div>
  );
}

function ErrorState(props: { error: Error; onRetry: () => unknown }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-md border border-destructive/40 p-4 text-sm"
    >
      <div>
        <p className="font-medium">{t('list.error.title')}</p>
        <p className="text-muted-foreground">
          {isApiError(props.error)
            ? props.error.detail
            : t('list.error.generic')}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void props.onRetry()}>
        {t('list.error.retry')}
      </Button>
    </div>
  );
}
