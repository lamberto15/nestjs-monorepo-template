'use client';

import type { Column, ReactTable, RowData } from '@tanstack/react-table';

import { cn } from 'cn';
// Patched in (not in the registry): the texts go through react-i18next (`list.table.*`).
import { useTranslation } from 'react-i18next';
import * as React from 'react';

import type { DataTableFeatures } from '@/lib/data-table-features';
import type { TFunction } from 'i18next';
import type {
  ColumnFilterItem,
  FilterOperator,
  FilterOperatorOption,
  FilterOption,
  FilterVariant,
  JoinOperator,
  OptionSearch,
} from '@/lib/data-table-types';
// Patched in: the API's search of a select's options (SearchSelectFilterValue).
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';

import {
  getDefaultFilter,
  getDateFilterLabel,
  getFilterDates,
  getFilterOperators,
  coerceFilterValue,
  getIsEditableTarget,
  getIsValuelessOperator,
  getSelectFilterValue,
  JOIN_OPERATORS,
  getFilterDateValue,
} from '@/lib/data-table-utils';
import { generateId } from '@/lib/id';
import { DataTableRangeFilter } from '@/components/data-table/data-table-range-filter';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Calendar } from '@nestjs-monorepo-template/ui/components/calendar';
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
  FacetedValue,
} from '@nestjs-monorepo-template/ui/components/faceted';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@nestjs-monorepo-template/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
} from '@nestjs-monorepo-template/ui/components/sortable';
import {
  ListFilter,
  Trash2,
  GripVertical,
  ChevronsUpDown,
  CalendarIcon,
} from 'lucide-react';

const FILTER_SHORTCUT_KEY = 'f';
const REMOVE_FILTER_SHORTCUTS = ['backspace', 'delete'];

function getIsRemoveKey(event: React.KeyboardEvent) {
  return REMOVE_FILTER_SHORTCUTS.includes(event.key.toLowerCase());
}

type FilterUpdate = Partial<Omit<ColumnFilterItem, 'filterId'>>;
type FilterSelector = 'field' | 'operator' | 'value';

interface DataTableFilterMenuProps<
  TData extends RowData,
> extends React.ComponentProps<typeof PopoverContent> {
  table: ReactTable<DataTableFeatures, TData, unknown>;
  disabled?: boolean;
}

export function DataTableFilterMenu<TData extends RowData>({
  table,
  ...props
}: DataTableFilterMenuProps<TData>) {
  return (
    <table.Subscribe
      selector={(state) => ({
        filters: table.getColumnFilterItems(),
        joinOperator: state.joinOperator,
      })}
    >
      {({ filters, joinOperator }) => (
        <DataTableFilterMenuContent
          table={table}
          filters={filters}
          joinOperator={joinOperator}
          {...props}
        />
      )}
    </table.Subscribe>
  );
}

interface DataTableFilterMenuContentProps<
  TData extends RowData,
> extends DataTableFilterMenuProps<TData> {
  filters: ColumnFilterItem[];
  joinOperator: JoinOperator;
}

function DataTableFilterMenuContent<TData extends RowData>({
  table,
  filters,
  joinOperator,
  disabled,
  ...props
}: DataTableFilterMenuContentProps<TData>) {
  const { t } = useTranslation();
  const dir = useDirection();
  const id = React.useId();
  const labelId = React.useId();
  const descriptionId = React.useId();
  const [open, setOpen] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (getIsEditableTarget(event.target)) return;
      if (
        event.key.toLowerCase() !== FILTER_SHORTCUT_KEY ||
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey
      ) {
        return;
      }

      event.preventDefault();
      setOpen((open) => !open);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const columns = React.useMemo(
    () => table.getAllColumns().filter((column) => column.getCanFilter()),
    [table],
  );

  const hasFilters = filters.length > 0;

  function onFilterAdd() {
    const column = columns[0];
    if (!column) return;

    table.addColumnFilter({
      ...getDefaultFilter(column),
      filterId: generateId({ length: 8 }),
    });
  }

  function onFilterUpdate(filterId: string, updates: FilterUpdate) {
    table.updateColumnFilter(filterId, updates);
  }

  function onFilterRemove(filterId: string) {
    table.removeColumnFilter(filterId);
    addButtonRef.current?.focus();
  }

  function onFiltersReset() {
    table.resetColumnFilters(true);
    table.resetJoinOperator(true);
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const lastFilter = filters.at(-1);
    if (!lastFilter || !getIsRemoveKey(event)) return;

    event.preventDefault();
    onFilterRemove(lastFilter.filterId);
  }

  return (
    <Sortable
      value={filters}
      onValueChange={(value) => table.setColumnFilters(value)}
      getItemValue={(item) => item.filterId}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              onKeyDown={onTriggerKeyDown}
              disabled={disabled}
            />
          }
        >
          <ListFilter className="text-muted-foreground" />
          {t('list.table.filter')}
          {hasFilters && (
            <Badge
              variant="secondary"
              className="h-[18.24px] px-[5.12px] font-mono text-[10.4px]"
            >
              {filters.length}
            </Badge>
          )}
        </PopoverTrigger>
        <PopoverContent
          dir={dir}
          aria-describedby={descriptionId}
          aria-labelledby={labelId}
          className="flex w-full max-w-(--available-width) flex-col gap-3.5 p-4 sm:min-w-95"
          {...props}
        >
          <div className="flex flex-col gap-1">
            <h4 id={labelId} className="leading-none font-medium">
              {hasFilters ? t('list.table.filters') : t('list.table.noFilters')}
            </h4>
            <p
              id={descriptionId}
              className={cn(
                'text-sm text-muted-foreground',
                hasFilters && 'sr-only',
              )}
            >
              {hasFilters
                ? t('list.table.modifyFilters')
                : t('list.table.addFiltersHint')}
            </p>
          </div>
          {hasFilters && (
            <SortableContent
              render={
                <div
                  role="list"
                  className="grid max-h-75 grid-cols-[minmax(4.5rem,auto)_8rem_8rem_minmax(10rem,max-content)_auto_auto] gap-x-2 gap-y-2 overflow-y-auto p-1"
                />
              }
            >
              {filters.map((filter, index) => (
                <DataTableFilterItem<TData>
                  key={filter.filterId}
                  filter={filter}
                  index={index}
                  filterItemId={`${id}-filter-${filter.filterId}`}
                  joinOperator={joinOperator}
                  columns={columns}
                  onJoinOperatorChange={(value) => table.setJoinOperator(value)}
                  onFilterUpdate={onFilterUpdate}
                  onFilterRemove={onFilterRemove}
                />
              ))}
            </SortableContent>
          )}
          <div className="flex w-full items-center gap-2">
            <Button ref={addButtonRef} onClick={onFilterAdd}>
              {t('list.table.addFilter')}
            </Button>
            {hasFilters && (
              <Button variant="outline" onClick={onFiltersReset}>
                {t('list.table.resetFilters')}
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <SortableOverlay>
        <div
          dir={dir}
          className="grid size-full grid-cols-[minmax(4.5rem,auto)_8rem_8rem_minmax(10rem,1fr)_auto_auto] items-center gap-2"
        >
          <div className="h-8 rounded-lg bg-primary/10" />
          <div className="h-8 rounded-lg bg-primary/10" />
          <div className="h-8 rounded-lg bg-primary/10" />
          <div className="h-8 rounded-lg bg-primary/10" />
          <div className="size-8 rounded-lg bg-primary/10" />
          <div className="size-8 rounded-lg bg-primary/10" />
        </div>
      </SortableOverlay>
    </Sortable>
  );
}

interface DataTableFilterItemProps<TData extends RowData> {
  filter: ColumnFilterItem;
  index: number;
  filterItemId: string;
  joinOperator: JoinOperator;
  columns: Column<DataTableFeatures, TData>[];
  onJoinOperatorChange: (value: JoinOperator) => void;
  onFilterUpdate: (filterId: string, updates: FilterUpdate) => void;
  onFilterRemove: (filterId: string) => void;
}

function DataTableFilterItem<TData extends RowData>({
  filter,
  index,
  filterItemId,
  joinOperator,
  columns,
  onJoinOperatorChange,
  onFilterUpdate,
  onFilterRemove,
}: DataTableFilterItemProps<TData>) {
  const { t } = useTranslation();
  const [activeSelector, setActiveSelector] =
    React.useState<FilterSelector | null>(null);

  const column = columns.find((column) => column.id === filter.id);
  if (!column) return null;

  const label = column.columnDef.meta?.label ?? column.id;

  function getSelectorProps(selector: FilterSelector) {
    return {
      open: activeSelector === selector,
      onOpenChange: (open: boolean) =>
        setActiveSelector(open ? selector : null),
    };
  }

  function onItemKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (activeSelector || getIsEditableTarget(event.target)) return;
    if (!getIsRemoveKey(event)) return;

    event.preventDefault();
    onFilterRemove(filter.filterId);
  }

  return (
    <SortableItem
      id={filterItemId}
      value={filter.filterId}
      render={
        <div
          role="listitem"
          tabIndex={-1}
          className="col-span-full grid grid-cols-subgrid items-center"
          onKeyDown={onItemKeyDown}
        />
      }
    >
      <div className="min-w-18 text-center">
        <FilterJoinOperator
          index={index}
          joinOperator={joinOperator}
          listboxId={`${filterItemId}-join-operator-listbox`}
          onJoinOperatorChange={onJoinOperatorChange}
        />
      </div>
      <FilterFieldSelector
        filter={filter}
        column={column}
        columns={columns}
        listboxId={`${filterItemId}-field-listbox`}
        onFilterUpdate={onFilterUpdate}
        {...getSelectorProps('field')}
      />
      <FilterOperatorSelector
        filter={filter}
        label={label}
        allowed={column.columnDef.meta?.operators}
        listboxId={`${filterItemId}-operator-listbox`}
        onFilterUpdate={onFilterUpdate}
        {...getSelectorProps('operator')}
      />
      <div className="w-full min-w-0">
        <FilterValueInput
          filter={filter}
          column={column}
          inputId={`${filterItemId}-input`}
          onFilterUpdate={onFilterUpdate}
          {...getSelectorProps('value')}
        />
      </div>
      <Button
        aria-controls={filterItemId}

        aria-label={t('list.table.removeFilter', { label })}
        variant="outline"
        size="icon"
        onClick={() => onFilterRemove(filter.filterId)}
      >
        <Trash2 />
      </Button>
      <SortableItemHandle
        aria-label={t('list.table.reorderFilter', { label })}
        render={<Button variant="outline" size="icon" />}
      >
        <GripVertical />
      </SortableItemHandle>
    </SortableItem>
  );
}

interface FilterJoinOperatorProps {
  index: number;
  joinOperator: JoinOperator;
  listboxId: string;
  onJoinOperatorChange: (value: JoinOperator) => void;
}

function FilterJoinOperator({
  index,
  joinOperator,
  listboxId,
  onJoinOperatorChange,
}: FilterJoinOperatorProps) {
  const { t } = useTranslation();
  const dir = useDirection();
  if (index === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        {t('list.table.where')}
      </span>
    );
  }

  if (index > 1) {
    return (
      <span className="text-sm text-muted-foreground">
        {t(`list.table.join.${joinOperator}`)}
      </span>
    );
  }

  return (
    <Select
      value={joinOperator}
      onValueChange={(value) => {
        if (value == null) return;
        onJoinOperatorChange(value);
      }}
    >
      <SelectTrigger
        aria-label={t('list.table.selectJoin')}
        aria-controls={listboxId}
        className="lowercase"
      >
        <SelectValue placeholder={joinOperator}>
          {(value: string) => t(`list.table.join.${value}`)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        dir={dir}
        id={listboxId}
        alignItemWithTrigger={false}
        className="min-w-(--anchor-width) lowercase"
      >
        <SelectGroup>
          {JOIN_OPERATORS.map((joinOperator) => (
            <SelectItem key={joinOperator} value={joinOperator}>
              {t(`list.table.join.${joinOperator}`)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

interface FilterSelectorProps {
  filter: ColumnFilterItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilterUpdate: (filterId: string, updates: FilterUpdate) => void;
}

interface FilterFieldSelectorProps<
  TData extends RowData,
> extends FilterSelectorProps {
  column: Column<DataTableFeatures, TData>;
  columns: Column<DataTableFeatures, TData>[];
  listboxId: string;
}

function FilterFieldSelector<TData extends RowData>({
  filter,
  column,
  columns,
  listboxId,
  open,
  onOpenChange,
  onFilterUpdate,
}: FilterFieldSelectorProps<TData>) {
  const { t } = useTranslation();
  const dir = useDirection();
  return (
    <Faceted
      open={open}
      onOpenChange={onOpenChange}
      value={filter.id}
      onValueChange={(columnId) => {
        const column = columns.find((column) => column.id === columnId);
        if (column) {
          onFilterUpdate(filter.filterId, getDefaultFilter(column));
        }
      }}
    >
      <FacetedTrigger
        render={
          <Button
            aria-controls={listboxId}
            variant="outline"
            className="w-32"
          />
        }
      >
        <span className="truncate">
          {column.columnDef.meta?.label ?? t('list.table.selectField')}
        </span>
        <ChevronsUpDown className="opacity-50" />
      </FacetedTrigger>
      <FacetedContent dir={dir} id={listboxId} className="w-40">
        <FacetedInput placeholder={t('list.table.searchFields')} />
        <FacetedList>
          <FacetedEmpty>{t('list.table.noFields')}</FacetedEmpty>
          <FacetedGroup>
            {columns.map((column) => (
              <FacetedItem key={column.id} value={column.id}>
                <span className="truncate">{column.columnDef.meta?.label}</span>
                <FacetedItemIndicator />
              </FacetedItem>
            ))}
          </FacetedGroup>
        </FacetedList>
      </FacetedContent>
    </Faceted>
  );
}

/**
 * An operator's text, translated: `list.table.operators.<operator>`, and the
 * date wording (before, after...) for the dates' ordered operators.
 */
function operatorLabel(
  t: TFunction,
  variant: FilterVariant,
  operator: FilterOperatorOption,
) {
  const date =
    (variant === 'date' || variant === 'dateRange') &&
    ['lt', 'lte', 'gt', 'gte'].includes(operator.value);
  return t(
    `list.table.${date ? 'dateOperators' : 'operators'}.${operator.value}`,
    { defaultValue: operator.label },
  );
}

interface FilterOperatorSelectorProps extends FilterSelectorProps {
  label: string;
  allowed?: FilterOperator[];
  listboxId: string;
}

function FilterOperatorSelector({
  filter,
  label,
  allowed,
  listboxId,
  open,
  onOpenChange,
  onFilterUpdate,
}: FilterOperatorSelectorProps) {
  const { t } = useTranslation();
  const dir = useDirection();
  return (
    <Select
      open={open}
      onOpenChange={onOpenChange}
      value={filter.operator}
      onValueChange={(operator) => {
        if (operator == null) return;
        onFilterUpdate(filter.filterId, {
          operator,
          value: coerceFilterValue(operator, filter.value),
        });
      }}
    >
      <SelectTrigger
        aria-controls={listboxId}
        aria-label={t('list.table.operatorAria', { label })}
        className="w-32 lowercase"
      >
        <div className="truncate">
          <SelectValue placeholder={filter.operator}>
            {(value: FilterOperator) => {
              const option = getFilterOperators(filter.variant, allowed).find(
                (o) => o.value === value,
              );
              return option ? operatorLabel(t, filter.variant, option) : value;
            }}
          </SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent dir={dir} id={listboxId}>
        <SelectGroup>
          {getFilterOperators(filter.variant, allowed).map((operator) => (
            <SelectItem
              key={operator.value}
              value={operator.value}
              className="lowercase"
            >
              {operatorLabel(t, filter.variant, operator)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

interface FilterValueInputProps<
  TData extends RowData,
> extends FilterSelectorProps {
  column: Column<DataTableFeatures, TData>;
  inputId: string;
}

function FilterValueInput<TData extends RowData>(
  props: FilterValueInputProps<TData>,
) {
  const { t } = useTranslation();
  const { filter, column, inputId, onFilterUpdate } = props;
  const columnMeta = column.columnDef.meta;

  if (getIsValuelessOperator(filter.operator)) {
    return (
      <div
        id={inputId}
        role="status"
        aria-label={t(
          filter.operator === 'isEmpty'
            ? 'list.table.filterIsEmpty'
            : 'list.table.filterIsNotEmpty',
          { label: columnMeta?.label },
        )}
        aria-live="polite"
        className="h-8 w-full rounded-lg border border-dashed border-input bg-transparent dark:bg-input/30"
      />
    );
  }

  switch (filter.variant) {
    case 'text':
    case 'number':
    case 'range':
      if (filter.operator === 'isBetween') {
        return (
          <DataTableRangeFilter
            filter={filter}
            column={column}
            inputId={inputId}
            onFilterUpdate={onFilterUpdate}
          />
        );
      }

      return (
        <Input
          id={inputId}
          type={filter.variant === 'text' ? 'text' : 'number'}
          aria-label={t('list.table.valueAria', { label: columnMeta?.label })}
          inputMode={filter.variant === 'text' ? undefined : 'numeric'}
          placeholder={columnMeta?.placeholder ?? t('list.table.enterValue')}
          defaultValue={
            typeof filter.value === 'string' ? filter.value : undefined
          }
          onChange={(event) =>
            onFilterUpdate(filter.filterId, { value: event.target.value })
          }
        />
      );

    case 'boolean':
      return <BooleanFilterValue {...props} />;

    case 'select':
    case 'multiSelect':
      // Keyed: another column's search is another query.
      return columnMeta?.search ? (
        <SearchSelectFilterValue key={column.id} {...props} />
      ) : (
        <SelectFilterValue {...props} />
      );

    case 'date':
    case 'dateRange':
      return <DateFilterValue {...props} />;

    default:
      return null;
  }
}

function BooleanFilterValue<TData extends RowData>({
  filter,
  column,
  inputId,
  open,
  onOpenChange,
  onFilterUpdate,
}: FilterValueInputProps<TData>) {
  const { t } = useTranslation();
  const dir = useDirection();
  const listboxId = `${inputId}-listbox`;

  return (
    <Select
      open={open}
      onOpenChange={onOpenChange}
      value={typeof filter.value === 'string' ? filter.value : null}
      onValueChange={(value) => {
        if (value == null) return;
        onFilterUpdate(filter.filterId, { value });
      }}
    >
      <SelectTrigger
        id={inputId}
        aria-controls={listboxId}
        aria-label={t('list.table.booleanAria', {
          label: column.columnDef.meta?.label,
        })}
        className="w-full"
      >
        <SelectValue placeholder={t('list.table.selectValue')}>
          {(value: string | null) =>
            value ? t(`list.table.${value}`) : t('list.table.selectValue')
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent dir={dir} id={listboxId}>
        <SelectGroup>
          <SelectItem value="true">{t('list.table.true')}</SelectItem>
          <SelectItem value="false">{t('list.table.false')}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function SelectFilterValue<TData extends RowData>({
  filter,
  column,
  inputId,
  open,
  onOpenChange,
  onFilterUpdate,
}: FilterValueInputProps<TData>) {
  const { t } = useTranslation();
  const dir = useDirection();
  const listboxId = `${inputId}-listbox`;
  const columnMeta = column.columnDef.meta;
  const multiple = filter.variant === 'multiSelect';

  return (
    <Faceted
      open={open}
      onOpenChange={onOpenChange}
      value={getSelectFilterValue(filter)}
      onValueChange={(value) =>
        onFilterUpdate(filter.filterId, { value: value ?? '' })
      }
      items={columnMeta?.options}
      multiple={multiple}
    >
      <FacetedTrigger
        render={
          <Button
            id={inputId}
            aria-controls={listboxId}
            aria-label={t('list.table.valueAria', { label: columnMeta?.label })}
            variant="outline"
            className="w-full hover:bg-muted/50 aria-expanded:bg-background dark:aria-expanded:bg-input/30"
          />
        }
      >
        <FacetedValue
          placeholder={
            columnMeta?.placeholder ??
            t(multiple ? 'list.table.selectOptions' : 'list.table.selectOption')
          }
        />
      </FacetedTrigger>
      <FacetedContent dir={dir} id={listboxId} className="w-50">
        <FacetedInput
          aria-label={t('list.table.searchOptionsAria', {
            label: columnMeta?.label,
          })}
          placeholder={columnMeta?.placeholder ?? t('list.table.searchOptions')}
        />
        <FacetedList>
          <FacetedEmpty>{t('list.table.noOptions')}</FacetedEmpty>
          <FacetedGroup>
            {columnMeta?.options?.map((option) => (
              <FacetedItem key={option.value} value={option.value}>
                {option.icon && <option.icon />}
                <span className="flex-1 truncate">{option.label}</span>
                <FacetedItemIndicator>{option.count}</FacetedItemIndicator>
              </FacetedItem>
            ))}
          </FacetedGroup>
        </FacetedList>
      </FacetedContent>
    </Faceted>
  );
}

/**
 * Patched in (not in the registry): a select whose options the API finds as
 * one types (`meta.search`, the users of a `ref: principal` field), too many
 * to list. The values already picked keep their names: `meta.options` and
 * every earlier search's answers name them.
 */
function SearchSelectFilterValue<TData extends RowData>({
  filter,
  column,
  inputId,
  open,
  onOpenChange,
  onFilterUpdate,
}: FilterValueInputProps<TData>) {
  const { t } = useTranslation();
  const dir = useDirection();
  const listboxId = `${inputId}-listbox`;
  const columnMeta = column.columnDef.meta;
  const search = columnMeta?.search as OptionSearch;
  const multiple = filter.variant === 'multiSelect';
  const [input, setInput] = React.useState('');
  const [term, setTerm] = React.useState('');
  const debounced = useDebouncedCallback((next: string) => setTerm(next), 250);
  const queryClient = useQueryClient();
  const found = useQuery({
    ...search.query(term),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
    meta: { errorToast: false },
  });
  const results = found.data ?? NO_OPTIONS;

  // Names of the values: known ones, then whatever any search found (read
  // on every render: a search's answer re-renders this, with more names).
  const labels = new Map<string, string>();
  for (const option of columnMeta?.options ?? []) {
    labels.set(option.value, option.label);
  }
  for (const [, options] of queryClient.getQueriesData<FilterOption[]>({
    queryKey: search.key,
  })) {
    for (const option of options ?? []) labels.set(option.value, option.label);
  }
  const items = [...labels].map(([value, label]) => ({ value, label }));

  return (
    <Faceted
      open={open}
      onOpenChange={onOpenChange}
      value={getSelectFilterValue(filter)}
      onValueChange={(value) =>
        onFilterUpdate(filter.filterId, { value: value ?? '' })
      }
      items={items}
      multiple={multiple}
    >
      <FacetedTrigger
        render={
          <Button
            id={inputId}
            aria-controls={listboxId}
            aria-label={t('list.table.valueAria', { label: columnMeta?.label })}
            variant="outline"
            className="w-full hover:bg-muted/50 aria-expanded:bg-background dark:aria-expanded:bg-input/30"
          />
        }
      >
        <FacetedValue
          placeholder={
            columnMeta?.placeholder ??
            t(multiple ? 'list.table.selectOptions' : 'list.table.selectOption')
          }
        />
      </FacetedTrigger>
      <FacetedContent
        dir={dir}
        id={listboxId}
        className="w-60"
        shouldFilter={false}
      >
        <FacetedInput
          aria-label={t('list.table.searchOptionsAria', {
            label: columnMeta?.label,
          })}
          placeholder={columnMeta?.placeholder ?? t('list.table.searchOptions')}
          value={input}
          onValueChange={(next) => {
            setInput(next);
            debounced(next);
          }}
        />
        <FacetedList>
          <FacetedEmpty>
            {found.isError
              ? t('list.refs.failed')
              : found.isFetching
                ? t('list.refs.searching')
                : t('list.table.noOptions')}
          </FacetedEmpty>
          <FacetedGroup>
            {results.map((option) => (
              <FacetedItem key={option.value} value={option.value}>
                <span className="flex-1 truncate">{option.label}</span>
                <FacetedItemIndicator />
              </FacetedItem>
            ))}
          </FacetedGroup>
        </FacetedList>
      </FacetedContent>
    </Faceted>
  );
}

const NO_OPTIONS: FilterOption[] = [];

function DateFilterValue<TData extends RowData>({
  filter,
  column,
  inputId,
  open,
  onOpenChange,
  onFilterUpdate,
}: FilterValueInputProps<TData>) {
  const { t } = useTranslation();
  const dir = useDirection();
  const listboxId = `${inputId}-listbox`;
  const label = column.columnDef.meta?.label;
  const [startDate, endDate] = getFilterDates(filter.value);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            id={inputId}
            aria-controls={listboxId}
            aria-label={t('list.table.dateAria', { label })}
            variant="outline"
            className={cn(
              'w-full justify-start text-start',
              !startDate && 'text-muted-foreground',
            )}
          />
        }
      >
        <CalendarIcon />
        <span className="truncate">
          {getDateFilterLabel(filter) ?? t('list.table.pickDate')}
        </span>
      </PopoverTrigger>
      <PopoverContent
        dir={dir}
        id={listboxId}
        align="start"
        className="w-auto p-0"
      >
        {filter.operator === 'isBetween' ? (
          <Calendar
            aria-label={t('list.table.selectDateRange', { label })}
            autoFocus
            captionLayout="dropdown"
            mode="range"
            selected={startDate ? { from: startDate, to: endDate } : undefined}
            onSelect={(range) =>
              onFilterUpdate(filter.filterId, {
                value: range
                  ? [
                      getFilterDateValue(range.from),
                      getFilterDateValue(range.to),
                    ]
                  : [],
              })
            }
          />
        ) : (
          <Calendar
            aria-label={t('list.table.selectDate', { label })}
            autoFocus
            captionLayout="dropdown"
            mode="single"
            selected={startDate}
            onSelect={(date) => {
              onFilterUpdate(filter.filterId, {
                value: getFilterDateValue(date),
              });
              onOpenChange(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
