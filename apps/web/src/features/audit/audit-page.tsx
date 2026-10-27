import { PersonName } from '@/components/person-name';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { DropdownMenuItem } from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { Label } from '@nestjs-monorepo-template/ui/components/label';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { useQuery } from '@tanstack/react-query';
import type { HeaderContext } from '@tanstack/react-table';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import type { AuditEntry } from '@/features/audit/api';
import type { DataTableFeatures } from '@/lib/data-table-features';
import { api } from '@/lib/api';
import { useDateTimeFormat } from '@/lib/date-time';
import { useCan, useMe } from '@/lib/features';
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
  const me = useMe();
  // "Include sub-tenants": the consolidated read of the tenant tree. Never
  // while impersonating (the API refuses it), so the switch is not offered.
  const canConsolidate =
    useCan('Access.readConsolidated') && !me?.user.impersonator;
  const [subtenants, setSubtenants] = useQueryState(
    'subtenants',
    parseAsBoolean.withDefault(false),
  );
  const consolidated = canConsolidate && subtenants;
  const tenants = useQuery({
    queryKey: ['access', 'consolidated', 'tenants'],
    queryFn: () => unwrap(api.GET('/v1/access/consolidated/tenants')),
    enabled: consolidated,
  });
  const tenantNames = useMemo(
    () =>
      new Map([
        ...(me?.tenant ? [[me.tenant.id, me.tenant.name] as const] : []),
        ...(tenants.data?.items ?? []).map((x) => [x.id, x.name] as const),
      ]),
    [me, tenants.data],
  );

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
      ...(consolidated
        ? [
            {
              // `tenantId` is a field and filter of the list; named from the tree.
              id: 'tenantId',
              accessorFn: (entry: AuditEntry) => entry.tenantId,
              ...header('tenant'),
              enableSorting: false,
              cell: ({ row }: { row: { original: AuditEntry } }) =>
                tenantNames.get(row.original.tenantId ?? '') ??
                row.original.tenantId,
            },
          ]
        : []),
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
  }, [t, format, consolidated, tenantNames]);

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
        // The two routes are two lists: start the table again on a switch.
        key={consolidated ? 'consolidated' : 'own'}
        subject="Audit"
        path={
          consolidated ? '/v1/access/consolidated/audit' : '/v1/access/audit'
        }
        title={t('title')}
        subtitle={
          consolidated && tenants.data
            ? tenants.data.items.length > 0
              ? t('subtenants.included', {
                  names: tenants.data.items.map((x) => x.name).join(', '),
                })
              : t('subtenants.none')
            : undefined
        }
        columns={columns}
        rowActions={rowActions}
        toolbarActions={
          canConsolidate && (
            <div className="flex items-center gap-2">
              <Switch
                id="audit-subtenants"
                checked={subtenants}
                onCheckedChange={(on) => void setSubtenants(on || null)}
              />
              <Label htmlFor="audit-subtenants">{t('subtenants.switch')}</Label>
            </div>
          )
        }
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
            <dt className="text-muted-foreground">{t('columns.ip')}</dt>
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
