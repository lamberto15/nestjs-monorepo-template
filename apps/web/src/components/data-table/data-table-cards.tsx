import {
  type Cell,
  FlexRender,
  type ReactTable,
  type Row,
  type RowData,
} from '@tanstack/react-table';
import { cn } from 'cn';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTablePagination } from '@/components/data-table/data-table-pagination';
import type { DataTableFeatures } from '@/lib/data-table-features';
import { getVisibleSelectedRows } from '@/lib/data-table-utils';

// Not from a registry: neither Dice UI nor shadcn has a list of cards for a
// table. It lays out the same TanStack table as `DataTable` (rows, cells,
// selection, pagination), one card a row, for a phone, where a table's
// columns would scroll sideways.

type AnyCell<TData extends RowData> = Cell<DataTableFeatures, TData>;

/** The checkbox and actions columns (`getDataTableSelectColumn`, `getDataTableActionsColumn`). */
const SELECT = 'select';
const ACTIONS = 'actions';
/** How many columns an unconfigured card shows as labelled lines. */
const META_LINES = 3;

interface DataTableCardsProps<TData extends RowData> {
  table: ReactTable<DataTableFeatures, TData, unknown>;
  actionBar?: React.ReactNode;
  /** A tap on a card (not on a link, button or menu inside it). */
  onRowClick?: (row: TData) => void;
  className?: string;
  'aria-busy'?: boolean;
}

export function DataTableCards<TData extends RowData>({
  table,
  actionBar,
  onRowClick,
  className,
  'aria-busy': busy,
}: DataTableCardsProps<TData>) {
  const { t } = useTranslation();
  return (
    <table.Subscribe
      selector={(state) => ({
        columnOrder: state.columnOrder,
        columnVisibility: state.columnVisibility,
        rowSelection: state.rowSelection,
      })}
    >
      {({ rowSelection }) => {
        const rows = table.getRowModel().rows;
        return (
          <div
            data-slot="data-table-cards"
            aria-busy={busy}
            className={cn('flex flex-col gap-2.5', className)}
          >
            {rows.length ? (
              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <DataTableCard
                    key={row.id}
                    row={row}
                    selected={rowSelection[row.id] === true}
                    onRowClick={onRowClick}
                  />
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                {t('list.table.noResults')}
              </p>
            )}
            <DataTablePagination table={table} />
            {actionBar && getVisibleSelectedRows(table).length > 0
              ? actionBar
              : null}
          </div>
        );
      }}
    </table.Subscribe>
  );
}

/** A cell's column name, for its line on the card. */
function labelOf<TData extends RowData>(cell: AnyCell<TData>) {
  const { columnDef, id } = cell.column;
  return (
    columnDef.meta?.label ??
    (typeof columnDef.header === 'string' ? columnDef.header : id)
  );
}

/** Which cell goes where on the card (`DataTableColumnMeta.mobile`). */
function place<TData extends RowData>(cells: AnyCell<TData>[]) {
  const role = (cell: AnyCell<TData>) => cell.column.columnDef.meta?.mobile;
  const content = cells.filter(
    (cell) => cell.column.id !== SELECT && cell.column.id !== ACTIONS,
  );
  const title =
    content.find((cell) => role(cell) === 'title') ??
    content.find((cell) => role(cell) === undefined);
  const rest = content.filter(
    (cell) => cell !== title && role(cell) !== 'hidden',
  );
  const meta = rest.filter((cell) => role(cell) === 'meta');
  const unset = rest.filter((cell) => role(cell) === undefined);
  return {
    select: cells.find((cell) => cell.column.id === SELECT),
    actions: cells.find((cell) => cell.column.id === ACTIONS),
    title,
    meta: [...meta, ...unset.slice(0, Math.max(0, META_LINES - meta.length))],
    badges: rest.filter((cell) => role(cell) === 'badge'),
  };
}

function DataTableCard<TData extends RowData>({
  row,
  selected,
  onRowClick,
}: {
  row: Row<DataTableFeatures, TData>;
  selected: boolean;
  onRowClick?: (row: TData) => void;
}) {
  const { select, actions, title, meta, badges } = place(row.getVisibleCells());
  return (
    // The tap is a shortcut, as on DataTable's rows: the keyboard reaches the
    // same page by the link in the row (its title, or `rowHref`'s page).
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <li
      data-state={selected ? 'selected' : undefined}
      className={cn(
        'flex items-start gap-3 rounded-lg border bg-card p-3 text-card-foreground data-[state=selected]:bg-muted',
        onRowClick && 'cursor-pointer',
      )}
      onClick={
        onRowClick
          ? (event) => {
              // As DataTable's rows: a tap on the card's own DOM, not on a
              // link, button or menu (portals bubble React events too).
              const target = event.target as HTMLElement;
              if (
                event.currentTarget.contains(target) &&
                !target.closest(
                  'a, button, [role="menuitem"], [role="checkbox"]',
                )
              ) {
                onRowClick(row.original);
              }
            }
          : undefined
      }
    >
      {select && (
        <div className="flex size-6 shrink-0 items-center justify-center">
          <FlexRender cell={select} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {title && (
          <div className="text-base font-medium [overflow-wrap:anywhere]">
            <FlexRender cell={title} />
          </div>
        )}
        {meta.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            {meta.map((cell) => (
              <Fragment key={cell.id}>
                <dt className="text-muted-foreground">{labelOf(cell)}</dt>
                <dd className="min-w-0 truncate">
                  <FlexRender cell={cell} />
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {badges.map((cell) => (
              <FlexRender key={cell.id} cell={cell} />
            ))}
          </div>
        )}
      </div>
      {actions && (
        // A thumb's target (44px), where the table's is a mouse's.
        <div className="-me-1 -mt-1 shrink-0 [&_button]:size-11">
          <FlexRender cell={actions} />
        </div>
      )}
    </li>
  );
}
