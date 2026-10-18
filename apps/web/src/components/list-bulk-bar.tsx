import {
  ActionBar,
  ActionBarClose,
  ActionBarGroup,
  ActionBarSelection,
  ActionBarSeparator,
} from '@nestjs-monorepo-template/ui/components/action-bar';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import type { ReactTable, RowData } from '@tanstack/react-table';
import { XIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_BULK_IDS } from '@/features/bulk/api';
import type { BulkContext } from '@/features/bulk/types';
import type { DataTableFeatures } from '@/lib/data-table-features';

/**
 * The action bar of a list with row selection (Dice UI's action-bar, as its
 * data-table doc places it): it appears with the first selected row, counts
 * them, offers "all N matching" (a run by the list's filter) when the whole
 * page is chosen, and shows what `actions` renders for the selection.
 */
export function ListBulkBar<TData extends RowData>(props: {
  table: ReactTable<DataTableFeatures, TData, unknown>;
  /** How many records the list's filter matches (`count=true`). */
  total?: number;
  /** The list's filter and search: what a run by filter acts on. */
  filter: Record<string, string>;
  actions: (context: BulkContext) => ReactNode;
}) {
  const { table } = props;
  return (
    <table.Subscribe selector={(state) => state.rowSelection}>
      {(rowSelection) => {
        const ids = Object.keys(rowSelection).filter((id) => rowSelection[id]);
        return ids.length === 0 ? null : <BarContent {...props} ids={ids} />;
      }}
    </table.Subscribe>
  );
}

function BarContent<TData extends RowData>(
  props: Parameters<typeof ListBulkBar<TData>>[0] & { ids: string[] },
) {
  const { t } = useTranslation();
  const { table, ids } = props;
  const [matching, setMatching] = useState(false);
  const clear = () => {
    setMatching(false);
    table.setRowSelection({});
  };
  const total = props.total ?? ids.length;
  const filterable = Object.keys(props.filter).length > 0;
  // A filter run needs at least one condition (docs/bulk-operations.md):
  // without any, "all" is the ids that are chosen.
  const offerAll =
    total > ids.length && table.getIsAllPageRowsSelected() && filterable;
  const tooMany = !matching && ids.length > MAX_BULK_IDS;
  const context: BulkContext = {
    selection: matching ? { filter: props.filter } : { ids },
    count: matching ? total : ids.length,
    clear,
  };
  return (
    <ActionBar
      open
      onOpenChange={(open) => !open && clear()}
      aria-label={t('list.bulk.label')}
    >
      <ActionBarSelection>
        {t('list.bulk.selected', { count: context.count })}
      </ActionBarSelection>
      {offerAll && !matching && (
        <Button size="sm" variant="ghost" onClick={() => setMatching(true)}>
          {t('list.bulk.selectAll', { count: total })}
        </Button>
      )}
      {matching && (
        <Button size="sm" variant="ghost" onClick={() => setMatching(false)}>
          {t('list.bulk.onlyChosen')}
        </Button>
      )}
      <ActionBarSeparator />
      {tooMany ? (
        <p role="alert" className="text-xs text-destructive">
          {t('list.bulk.tooMany', { max: MAX_BULK_IDS })}
        </p>
      ) : (
        <ActionBarGroup>{props.actions(context)}</ActionBarGroup>
      )}
      <ActionBarClose
        aria-label={t('list.bulk.clear')}
        render={<Button variant="ghost" size="icon-sm" />}
      >
        <XIcon />
      </ActionBarClose>
    </ActionBar>
  );
}
