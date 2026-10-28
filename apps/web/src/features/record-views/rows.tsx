import { FlexRender, useTable, type Row } from '@tanstack/react-table';
import { useRouter } from '@tanstack/react-router';
import type { ColumnVisibilityState } from '@tanstack/react-table';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  dataTableFeatures,
  type DataTableFeatures,
} from '@/lib/data-table-features';
import type { ListColumn, ListDescription } from '@/lib/list-query';

/** What every view of a list is given by the list page. */
export interface ViewProps {
  /** The list route, and the values of its `{placeholders}`. */
  path: string;
  pathParams?: Record<string, string>;
  /** The subject's metadata (GET /v1/lists/{subject}) and its list's own scope (`query` of the page). */
  description: ListDescription;
  extra?: Record<string, string>;
  /** The list route's query for the table's filters, search, sort and visible columns. */
  params: Record<string, string>;
  /** The table's data columns (not its checkboxes or actions) and which are visible: a card shows those. */
  columns: ListColumn<never>[];
  visibility: ColumnVisibilityState;
  /** Where a record's page is. */
  rowHref?: (row: never) => string;
  /** Whether writes are off now (read-only or maintenance mode). */
  paused: boolean;
}

/** How many labelled lines follow a card's title. */
const LINES = 2;

/**
 * The records of a view as rows of a TanStack table with the list's own
 * columns, so a card shows the cells the table does and only the columns the
 * user left visible. The rows are exactly `data`: filtering, order and paging
 * are the API's.
 */
export function useRecordRows<T extends { id: string }>(
  data: T[],
  columns: ListColumn<never>[],
  visibility: ColumnVisibilityState,
) {
  return useTable({
    features: dataTableFeatures,
    columns: columns as unknown as ListColumn<T>[],
    data,
    getRowId: (row) => row.id,
    state: { columnVisibility: visibility },
    manualFiltering: true,
    manualSorting: true,
    manualPagination: true,
  }).getRowModel().rows;
}

/** A record's first visible cell as its title and the next ones as labelled lines. */
export function RecordSummary<T extends { id: string }>(props: {
  row: Row<DataTableFeatures, T>;
  /** The record's page: a link to it follows the lines. */
  href?: string;
  /** Only the title (a month's cell). */
  compact?: boolean;
}) {
  const { t } = useTranslation('record-views');
  const [title, ...rest] = props.row.getVisibleCells();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {title && (
        <div className="font-medium [overflow-wrap:anywhere]">
          <FlexRender cell={title} />
        </div>
      )}
      {!props.compact && rest.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
          {rest.slice(0, LINES).map((cell) => {
            const { columnDef, id } = cell.column;
            return (
              <Fragment key={cell.id}>
                <dt className="text-muted-foreground">
                  {columnDef.meta?.label ?? id}
                </dt>
                <dd className="min-w-0 truncate">
                  <FlexRender cell={cell} />
                </dd>
              </Fragment>
            );
          })}
        </dl>
      )}
      {props.href && (
        <RowLink
          href={props.href}
          className="text-xs underline underline-offset-4"
          aria-label={t('open', { title: titleOf(props.row) })}
        >
          {t('openShort')}
        </RowLink>
      )}
    </div>
  );
}

/** The text a record goes by: the value of its first visible column. */
export function titleOf<T extends { id: string }>(
  row: Row<DataTableFeatures, T>,
) {
  return String(row.getVisibleCells()[0]?.getValue() ?? row.id);
}

/** A link to a record's page that keeps the single-page navigation; just the text without a `href`. */
export function RowLink(props: {
  href?: string;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  const router = useRouter({ warn: false });
  if (!props.href) return props.children;
  const { href } = props;
  return (
    <a
      href={href}
      aria-label={props['aria-label']}
      className={props.className ?? 'underline underline-offset-4'}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || !router) return;
        event.preventDefault();
        router.history.push(href);
      }}
    >
      {props.children}
    </a>
  );
}
