'use client';

import {
  Subscribe,
  type CellContext,
  type ColumnDef,
  type HeaderContext,
  type RowData,
} from '@tanstack/react-table';
import { cn } from 'cn';
// Patched in (not in the registry): the labels go through react-i18next (`list.table.*`).
import { useTranslation } from 'react-i18next';

import type { DataTableFeatures } from '@/lib/data-table-features';

import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';

interface GetDataTableSelectColumnOptions<TData extends RowData> extends Omit<
  Partial<ColumnDef<DataTableFeatures, TData>>,
  'id' | 'header' | 'cell'
> {
  debug?: boolean;
}

export function getDataTableSelectColumn<TData extends RowData>({
  size = 40,
  enableHiding = false,
  enableSorting = false,
  debug = false,
  ...props
}: GetDataTableSelectColumnOptions<TData> = {}): ColumnDef<
  DataTableFeatures,
  TData
> {
  return {
    id: 'select',
    header: ({ table }) => (
      <DataTableSelectHeader table={table} debug={debug} />
    ),
    cell: ({ row }) => <DataTableSelectCell row={row} debug={debug} />,
    size,
    enableHiding,
    enableSorting,
    ...props,
  };
}

function getHitboxClassName(debug?: boolean) {
  return cn(
    'select-none after:-inset-2',
    debug &&
      'after:border after:border-dashed after:border-red-500 after:bg-red-500/20',
  );
}

interface DataTableSelectHeaderProps<TData extends RowData> extends Pick<
  HeaderContext<DataTableFeatures, TData>,
  'table'
> {
  debug?: boolean;
}

function DataTableSelectHeader<TData extends RowData>({
  table,
  debug,
}: DataTableSelectHeaderProps<TData>) {
  const { t } = useTranslation();
  return (
    <Subscribe
      source={table.atoms.rowSelection}
      selector={() => ({
        checked: table.getIsAllPageRowsSelected(),
        indeterminate:
          table.getIsSomePageRowsSelected() &&
          !table.getIsAllPageRowsSelected(),
      })}
    >
      {({ checked, indeterminate }) => (
        <Checkbox
          aria-label={t('list.table.selectAll')}
          className={getHitboxClassName(debug)}
          checked={checked}
          indeterminate={indeterminate}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(value)}
        />
      )}
    </Subscribe>
  );
}

interface DataTableSelectCellProps<TData extends RowData> extends Pick<
  CellContext<DataTableFeatures, TData>,
  'row'
> {
  debug?: boolean;
}

function DataTableSelectCell<TData extends RowData>({
  row,
  debug,
}: DataTableSelectCellProps<TData>) {
  const { t } = useTranslation();
  return (
    <Subscribe
      source={row.table.atoms.rowSelection}
      selector={(selection) => selection[row.id] === true}
    >
      {(isSelected) => (
        <Checkbox
          aria-label={t('list.table.selectRow')}
          className={getHitboxClassName(debug)}
          checked={isSelected}
          onClick={(event) => {
            if (row.table.options.enableRowRangeSelection !== true) {
              row.toggleSelected(!isSelected);
              return;
            }

            if (event.shiftKey) event.preventDefault();

            row.getToggleSelectedHandler()({
              target: { checked: !isSelected },
              shiftKey: event.shiftKey,
              nativeEvent: event.nativeEvent,
            });
          }}
        />
      )}
    </Subscribe>
  );
}
