'use client';

import {
  type ReactTable,
  type RowData,
  Subscribe,
} from '@tanstack/react-table';
import { cn } from 'cn';
// Patched in (not in the registry): the texts go through react-i18next (`list.table.*`).
import { useTranslation } from 'react-i18next';
import * as React from 'react';

import type { DataTableFeatures } from '@/lib/data-table-features';

import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useDirection } from '@nestjs-monorepo-template/ui/components/direction';
import {
  Faceted,
  FacetedContent,
  FacetedEmpty,
  FacetedGroup,
  FacetedInput,
  FacetedItem,
  FacetedItemIndicator,
  FacetedList,
  FacetedTrigger,
} from '@nestjs-monorepo-template/ui/components/faceted';
import { Settings2 } from 'lucide-react';

interface DataTableViewOptionsProps<
  TData extends RowData,
> extends React.ComponentProps<typeof FacetedContent> {
  table: ReactTable<DataTableFeatures, TData, unknown>;
  disabled?: boolean;
}

export function DataTableViewOptions<TData extends RowData>({
  table,
  disabled,
  className,
  ...props
}: DataTableViewOptionsProps<TData>) {
  const { t } = useTranslation();
  const dir = useDirection();
  const columns = React.useMemo(
    () =>
      table
        .getAllColumns()
        .filter(
          (column) =>
            typeof column.accessorFn !== 'undefined' && column.getCanHide(),
        ),
    [table],
  );

  return (
    <Subscribe source={table.atoms.columnVisibility}>
      {(columnVisibility) => (
        <Faceted
          multiple
          value={columns
            .filter((column) => columnVisibility[column.id] !== false)
            .map((column) => column.id)}
        >
          <FacetedTrigger
            render={
              <Button
                aria-label={t('list.table.viewColumns')}
                variant="outline"
                className="ms-auto hidden lg:flex"
                disabled={disabled}
              />
            }
          >
            <Settings2 className="text-muted-foreground" />
            {t('list.table.view')}
          </FacetedTrigger>
          <FacetedContent
            aria-label={t('list.table.columns')}
            dir={dir}
            align="center"
            className={cn('w-44', className)}
            {...props}
          >
            <FacetedInput placeholder={t('list.table.searchColumns')} />
            <FacetedList>
              <FacetedEmpty>{t('list.table.noColumns')}</FacetedEmpty>
              <FacetedGroup>
                {columns.map((column) => (
                  <FacetedItem
                    key={column.id}
                    value={column.id}
                    onSelect={() => column.toggleVisibility()}
                  >
                    <span className="truncate">
                      {column.columnDef.meta?.label ?? column.id}
                    </span>
                    <FacetedItemIndicator />
                  </FacetedItem>
                ))}
              </FacetedGroup>
            </FacetedList>
          </FacetedContent>
        </Faceted>
      )}
    </Subscribe>
  );
}
