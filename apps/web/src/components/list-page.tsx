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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable } from '@/components/data-table/data-table';
import { getDataTableActionsColumn } from '@/components/data-table/data-table-actions-column';
import { DataTableAdvancedToolbar } from '@/components/data-table/data-table-advanced-toolbar';
import { DataTableFilterMenu } from '@/components/data-table/data-table-filter-menu';
import { DataTableSkeleton } from '@/components/data-table/data-table-skeleton';
import { DataTableSortMenu } from '@/components/data-table/data-table-sort-menu';
import { useDataTable } from '@/hooks/use-data-table';
import type { DataTableFeatures } from '@/lib/data-table-features';
import {
  DEFAULT_PER_PAGE,
  defaultSorting,
  useListDescription,
  useListQuery,
  withListMeta,
  type ListColumn,
  type ListDescription,
  type ListPath,
  type ListRow,
} from '@/lib/list-query';

export interface ListPageProps<P extends ListPath> {
  /** The subject of GET /v1/lists/{subject} (`Note`). */
  subject: string;
  /** The list route (`/v1/notes`). */
  path: P;
  /** Cells and headers; filters and sorting come from the list's metadata. */
  columns: ListColumn<ListRow<P>>[];
  /** The heading above the table. */
  title: string;
  /** Buttons beside the heading: "New", a recycle-bin toggle. */
  toolbarActions?: ReactNode;
  /** More query parameters of the list route (`{ deleted: 'true' }`: the bin). */
  query?: Record<string, string>;
  /** Where a click on a row goes (a link inside the row keeps its own). */
  rowHref?: (row: ListRow<P>) => string;
  /**
   * The items of a row's actions menu (DropdownMenuItem…), as a last column.
   * Keep it stable (useCallback) so the table is not rebuilt.
   */
  rowActions?: (row: ListRow<P>) => ReactNode;
}

/**
 * A server-paginated, filterable, sortable list of any subject: the table's
 * state is in the URL (nuqs), the page comes from the API (TanStack Query).
 */
export function ListPage<P extends ListPath>(props: ListPageProps<P>) {
  const description = useListDescription(props.subject);
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">{props.title}</h1>
        {props.toolbarActions && (
          <div className="flex items-center gap-2">{props.toolbarActions}</div>
        )}
      </div>
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
    </section>
  );
}

function ListTable<P extends ListPath>({
  path,
  columns,
  description,
  query: extraQuery,
  rowHref,
  rowActions,
}: ListPageProps<P> & { description: ListDescription }) {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const cols = useMemo(() => {
    const withMeta = withListMeta(columns, description);
    return rowActions
      ? [
          ...withMeta,
          getDataTableActionsColumn<ListRow<P>>({
            actions: ({ row }) => rowActions(row.original),
          }),
        ]
      : withMeta;
  }, [columns, description, rowActions]);
  const [fields, setFields] = useState(() =>
    cols.flatMap((c) => (c.id ? [c.id] : [])),
  );
  const query = useListQuery(path, description, cols, fields, extraQuery);

  const { table } = useDataTable({
    data: query.data?.items ?? EMPTY,
    columns: cols,
    pageCount: query.data?.pageCount ?? 1,
    initialState: {
      sorting: defaultSorting(description),
      pagination: { pageIndex: 0, pageSize: DEFAULT_PER_PAGE },
    },
    getRowId: (row) => (row as { id: string }).id,
  });

  const filtered = 'filter' in query.params || 'q' in query.params;
  const empty = query.isSuccess && query.data.items.length === 0 && !filtered;

  return (
    <div className="flex flex-col gap-2">
      <FieldsSync table={table} onChange={setFields} />
      <DataTableAdvancedToolbar table={table}>
        {description.search && (
          <SearchBox value={query.q} onSearch={query.search} />
        )}
        <DataTableFilterMenu table={table} />
        <DataTableSortMenu table={table} />
      </DataTableAdvancedToolbar>
      {query.isError ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : query.isPending ? (
        <DataTableSkeleton columnCount={cols.length} withViewOptions={false} />
      ) : empty ? (
        <div
          role="status"
          className="rounded-md border p-8 text-center text-sm text-muted-foreground"
        >
          <p className="font-medium text-foreground">{t('list.empty.title')}</p>
          <p>{t('list.empty.description')}</p>
        </div>
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

function SearchBox(props: { value: string; onSearch: (q: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(props.value);
  return (
    <div className="relative">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={t('list.search')}
        placeholder={t('list.search')}
        className="h-8 w-48 ps-8 lg:w-64"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          props.onSearch(event.target.value);
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
