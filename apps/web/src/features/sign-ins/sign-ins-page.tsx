import type { HeaderContext } from '@tanstack/react-table';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import type { SignInEntry } from '@/features/sign-ins/api';
import type { DataTableFeatures } from '@/lib/data-table-features';
import { useDateTimeFormat } from '@/lib/date-time';
import type { ListColumn } from '@/lib/list-query';

/**
 * The tenant's sign-in history (`GET /v1/access/sign-ins`) on the generic
 * list page: filters (user, method, result, ip, time), sorts and paging come
 * from GET /v1/lists/SignIn.
 */
export function SignInsPage() {
  const { t } = useTranslation('sign-ins');
  const format = useDateTimeFormat();

  // Cells and headers only: filters and sorts come from the list's metadata.
  const columns = useMemo<ListColumn<SignInEntry>[]>(() => {
    const header = (key: string) => {
      const label = t(`columns.${key}`);
      return {
        meta: { label },
        header: ({
          column,
        }: HeaderContext<DataTableFeatures, SignInEntry, unknown>) => (
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
        id: 'userLabel',
        accessorFn: (entry) => entry.userLabel,
        ...header('user'),
        // The member's name now; the stored address for a former member.
        cell: ({ row }) => row.original.userName ?? row.original.userLabel,
      },
      {
        id: 'result',
        accessorKey: 'result',
        ...header('result'),
        cell: ({ row }) => t(`result.${row.original.result}`),
      },
      {
        id: 'method',
        accessorKey: 'method',
        ...header('method'),
        cell: ({ row }) => mono(row.original.method),
      },
      {
        id: 'via',
        accessorKey: 'via',
        ...header('via'),
      },
      {
        id: 'userAgent',
        accessorKey: 'userAgent',
        ...header('userAgent'),
      },
      {
        id: 'ip',
        accessorKey: 'ip',
        ...header('ip'),
        cell: ({ row }) => mono(row.original.ip),
      },
    ];
  }, [t, format]);

  return (
    <ListPage
      subject="SignIn"
      path="/v1/access/sign-ins"
      title={t('title')}
      columns={columns}
    />
  );
}
