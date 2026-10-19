import { PersonName } from '@/components/person-name';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { DropdownMenuItem } from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import type { HeaderContext } from '@tanstack/react-table';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import type { AuditEntry } from '@/features/audit/api';
import type { DataTableFeatures } from '@/lib/data-table-features';
import { useDateTimeFormat } from '@/lib/date-time';
import type { ListColumn } from '@/lib/list-query';

/** Details as text: a string as is, anything else as indented JSON. Never HTML. */
export function detailsText(details: unknown): string {
  if (details === null || details === undefined) {
    return '';
  }
  return typeof details === 'string'
    ? details
    : (JSON.stringify(details, null, 2) ?? '');
}

/**
 * The audit log (`GET /v1/access/audit`) on the generic list page: filters
 * (the actor by name or address included), sorts and paging come from
 * GET /v1/lists/Audit; the details of an entry open from its row's menu.
 */
export function AuditPage() {
  const { t } = useTranslation('audit');
  const format = useDateTimeFormat();
  const [shown, setShown] = useState<AuditEntry>();

  // Cells and headers only: filters and sorts come from the list's metadata.
  const columns = useMemo<ListColumn<AuditEntry>[]>(() => {
    const header = (key: string) => {
      const label = t(`columns.${key}`);
      return {
        meta: { label },
        header: ({
          column,
        }: HeaderContext<DataTableFeatures, AuditEntry, unknown>) => (
          <DataTableColumnHeader column={column} label={label} />
        ),
      };
    };
    const mono = (value: string | null) => (
      <span className="font-mono text-xs">{value}</span>
    );
    return [
      {
        id: 'at',
        accessorFn: (entry) => format(entry.at),
        ...header('at'),
      },
      {
        id: 'actorLabel',
        accessorFn: (entry) => entry.actorLabel,
        ...header('actor'),
        // No stored label: the person by key (one batched lookup for the
        // page). `actor` comes only when its own column is shown, and
        // `system:*` stays as it is.
        cell: ({ row }) =>
          row.original.actorLabel ??
          (row.original.actor ? (
            <PersonName value={row.original.actor} />
          ) : null),
      },
      {
        id: 'action',
        accessorKey: 'action',
        ...header('action'),
        cell: ({ row }) => mono(row.original.action),
      },
      {
        id: 'targetType',
        accessorKey: 'targetType',
        ...header('targetType'),
      },
      {
        id: 'targetId',
        accessorKey: 'targetId',
        ...header('targetId'),
        cell: ({ row }) => mono(row.original.targetId),
      },
      {
        id: 'ip',
        accessorKey: 'ip',
        ...header('ip'),
        cell: ({ row }) => mono(row.original.ip),
      },
      {
        // Asked for so the row's dialog has them; the cell is a glimpse.
        id: 'details',
        accessorFn: (entry) => detailsText(entry.details),
        ...header('details'),
        cell: ({ row }) => (
          <span className="block max-w-64 truncate font-mono text-xs">
            {row.original.details ? JSON.stringify(row.original.details) : ''}
          </span>
        ),
      },
    ];
  }, [t, format]);

  const rowActions = useCallback(
    (entry: AuditEntry) => (
      <DropdownMenuItem onClick={() => setShown(entry)}>
        {t('details.open')}
      </DropdownMenuItem>
    ),
    [t],
  );

  return (
    <>
      <ListPage
        subject="Audit"
        path="/v1/access/audit"
        title={t('title')}
        columns={columns}
        rowActions={rowActions}
      />
      <Dialog
        open={!!shown}
        onOpenChange={(open) => !open && setShown(undefined)}
      >
        <DialogContent className="sm:max-w-xl">
          {shown && <EntryDetails entry={shown} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EntryDetails(props: { entry: AuditEntry }) {
  const { t } = useTranslation('audit');
  const format = useDateTimeFormat();
  const { entry } = props;
  const text = detailsText(entry.details);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono text-base">
          {entry.action}
        </DialogTitle>
        <DialogDescription>{format(entry.at)}</DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        <dt className="text-muted-foreground">{t('details.actor')}</dt>
        <dd>
          {entry.actorLabel ??
            (entry.actor ? <PersonName value={entry.actor} /> : null)}
        </dd>
        {/* Only when the actor column is shown: the page asks for what it shows. */}
        {entry.actor && (
          <>
            <dt className="text-muted-foreground">{t('details.actorId')}</dt>
            <dd className="font-mono">{entry.actor}</dd>
          </>
        )}
        {entry.ip && (
          <>
            <dt className="text-muted-foreground">{t('details.ip')}</dt>
            <dd className="font-mono">{entry.ip}</dd>
          </>
        )}
      </dl>
      {/* Text in a <pre>: React escapes it, nothing is parsed as HTML. */}
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
        {text || t('details.none')}
      </pre>
    </>
  );
}
