import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import type { ReactTable, RowData } from '@tanstack/react-table';
import { BookmarkIcon, CheckIcon } from 'lucide-react';
import { useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useCurrentPath } from '@/features/favorites/api';
import { FavoriteButton } from '@/features/favorites/favorite-button';
import type { DataTableFeatures } from '@/lib/data-table-features';
import type { FilterOperator } from '@/lib/data-table-types';
import { defaultSorting, type ListDescription } from '@/lib/list-query';
import { useApplyView, useDeleteView, useViews, type SavedView } from './api';
import { ViewDialog } from './view-dialog';
import {
  UnshowableView,
  viewState,
  type FilterColumn,
  type ViewContext,
} from './view-state';

const GROUPS = ['private', 'unit', 'tenant'] as const;

/** What the table can filter and sort by, as `viewState` needs it. */
function contextOf<TData extends RowData>(
  table: ReactTable<DataTableFeatures, TData, unknown>,
  description: ListDescription,
): ViewContext {
  const types = new Map(description.fields.map((f) => [f.name, f.type]));
  const filterable: Record<string, FilterColumn> = {};
  const sortable = new Set<string>();
  for (const column of table.getAllLeafColumns()) {
    const meta = column.columnDef.meta;
    if (column.columnDef.enableColumnFilter && meta?.variant) {
      filterable[column.id] = {
        variant: meta.variant,
        operators: (meta.operators ?? []) as FilterOperator[],
        type: types.get(column.id) ?? 'string',
      };
    }
    if (column.getCanSort()) sortable.add(column.id);
  }
  return {
    filterable,
    sortable,
    fieldOperators: Object.fromEntries(
      description.fields.map((f) => [f.name, f.operators]),
    ),
  };
}

/**
 * The saved views of a list (docs/saved-views.md): choose one to apply it to
 * the table (its filter, search, sort and columns), save the table as a new
 * one (private, a unit's, or the tenant's), rename or delete the chosen one.
 * The views are read when the menu opens.
 */
export function ViewsPicker<TData extends RowData>(props: {
  subject: string;
  description: ListDescription;
  table: ReactTable<DataTableFeatures, TData, unknown>;
  /** The list route's current query (`useListQuery().params`). */
  params: Record<string, string>;
  /** Sets the search box and the query's `q`. */
  onSearch: (q: string) => void;
}) {
  const { t } = useTranslation('views');
  const path = useCurrentPath();
  const { table, description } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<SavedView>();
  const [dialog, setDialog] = useState<'save' | 'rename' | 'delete'>();
  const views = useViews(props.subject, open);
  const apply = useApplyView();
  const remove = useDeleteView();

  async function choose(view: Pick<SavedView, 'id' | 'name'>) {
    try {
      const applied = await apply.mutateAsync(view.id);
      const state = viewState(applied.params, contextOf(table, description));
      table.setColumnFilters(state.filters);
      table.setJoinOperator(state.joinOperator);
      table.setSorting(
        state.sorting.length > 0 ? state.sorting : defaultSorting(description),
      );
      table.setPageIndex(0);
      props.onSearch(state.q);
      if (applied.columns) {
        const shown = new Set(applied.columns);
        const data = new Set(description.select);
        table.setColumnVisibility(
          Object.fromEntries(
            table
              .getAllLeafColumns()
              .filter((c) => data.has(c.id))
              .map((c) => [c.id, shown.has(c.id)]),
          ),
        );
      } else {
        table.resetColumnVisibility();
      }
      setActive(applied.view);
      toast.success(t('applied', { name: applied.view.name }));
    } catch (caught) {
      const name = view.name;
      if (caught instanceof UnshowableView) {
        toast.error(t('unshowable', { name, what: caught.what }));
      } else if (isApiError(caught) && caught.status === 400) {
        // A stale view: a custom field deactivated, a list that changed. The
        // detail names `query.<parameter>`.
        toast.error(t('stale', { name, detail: caught.detail }));
      } else if (isApiError(caught) && caught.status === 404) {
        toast.error(t('gone', { name }));
        void views.refetch();
      } else if (isApiError(caught)) {
        // 403 `field_forbidden`: a filter on a field the user may not read.
        toast.error(t('forbidden', { name, detail: caught.detail }));
      } else {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  // What "save" keeps: the query that says which records and in what order,
  // and the columns shown (the list route's own `fields=`).
  const current = () => {
    const { filter, sort, q, fields } = props.params;
    const select = new Set(description.select);
    const columns = (fields?.split(',') ?? []).filter((f) => select.has(f));
    return {
      query: {
        ...(filter && { filter }),
        ...(sort && { sort }),
        ...(q && { q }),
      },
      columns: columns.length > 0 ? columns : null,
    };
  };

  // A view opened from the menu's favorites (`?view=<id>`): applied once,
  // then out of the URL (the list's own parameters say what it shows).
  const [opened, setOpened] = useQueryState('view');
  useEffect(() => {
    if (opened) {
      void setOpened(null);
      void choose({ id: opened, name: opened });
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per id: `choose` reads the table as it is then.
  }, [opened]);

  const items = views.data?.items ?? [];
  return (
    <>
      {active && (
        <FavoriteButton
          kind="view"
          subject={path}
          target={active.id}
          label={active.name}
        />
      )}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              aria-label={
                active ? t('current', { name: active.name }) : t('title')
              }
            />
          }
        >
          <BookmarkIcon />
          <span className="max-w-40 truncate">
            {active ? active.name : t('button')}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {views.isPending && (
            <p
              role="status"
              className="px-2 py-1.5 text-sm text-muted-foreground"
            >
              {t('loading')}
            </p>
          )}
          {views.isError && (
            <p role="alert" className="px-2 py-1.5 text-sm text-destructive">
              {t('failed')}
            </p>
          )}
          {views.isSuccess && items.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {t('none')}
            </p>
          )}
          {GROUPS.map((visibility) => {
            const group = items.filter((v) => v.visibility === visibility);
            return (
              group.length > 0 && (
                <DropdownMenuGroup key={visibility}>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {t(`groups.${visibility}`)}
                  </DropdownMenuLabel>
                  {group.map((view) => (
                    <DropdownMenuItem
                      key={view.id}
                      onClick={() => void choose(view)}
                    >
                      <span className="flex-1 truncate">{view.name}</span>
                      {view.id === active?.id && <CheckIcon />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              )
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setDialog('save')}>
              {t('saveCurrent')}
            </DropdownMenuItem>
            {active?.editable && (
              <>
                <DropdownMenuItem onClick={() => setDialog('rename')}>
                  {t('rename', { name: active.name })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDialog('delete')}
                >
                  {t('delete', { name: active.name })}
                </DropdownMenuItem>
              </>
            )}
            {active && (
              <DropdownMenuItem onClick={() => setActive(undefined)}>
                {t('clear', { name: active.name })}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === 'save' && (
        <ViewDialog
          subject={props.subject}
          current={current()}
          onSaved={setActive}
          onOpenChange={(next) => !next && setDialog(undefined)}
        />
      )}
      {dialog === 'rename' && active && (
        <ViewDialog
          subject={props.subject}
          view={active}
          onSaved={setActive}
          onOpenChange={(next) => !next && setDialog(undefined)}
        />
      )}
      {dialog === 'delete' && active && (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setDialog(undefined)}
          title={t('deleteTitle', { name: active.name })}
          description={t('deleteDescription')}
          confirm={t('deleteConfirm')}
          onConfirm={async () => {
            await remove.mutateAsync(active.id);
            toast.success(t('deleted'));
            setActive(undefined);
          }}
        />
      )}
    </>
  );
}
