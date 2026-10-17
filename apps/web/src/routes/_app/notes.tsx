import type { paths } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { createFileRoute } from '@tanstack/react-router';
import type { HeaderContext } from '@tanstack/react-table';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import type { DataTableFeatures } from '@/lib/data-table-features';
import type { ListColumn } from '@/lib/list-query';
import { TagBadge } from '@/lib/tags';

export const Route = createFileRoute('/_app/notes')({
  component: Notes,
});

type Note =
  paths['/v1/notes']['get']['responses'][200]['content']['application/json']['items'][number];

function Notes() {
  const { t, i18n } = useTranslation();

  // Cells and headers only: whether a column filters or sorts, and how, comes
  // from GET /v1/lists/Note (see withListMeta).
  const columns = useMemo<ListColumn<Note>[]>(() => {
    const date = (value: string | null) =>
      value
        ? new Intl.DateTimeFormat(i18n.language, {
            dateStyle: 'medium',
          }).format(new Date(value))
        : '';
    const header = (key: string) => {
      const label = t(`notes.columns.${key}`);
      return {
        meta: { label },
        header: ({
          column,
        }: HeaderContext<DataTableFeatures, Note, unknown>) => (
          <DataTableColumnHeader column={column} label={label} />
        ),
      };
    };
    return [
      { id: 'number', accessorKey: 'number', ...header('number') },
      { id: 'title', accessorKey: 'title', ...header('title') },
      {
        id: 'status',
        accessorKey: 'status',
        ...header('status'),
        cell: ({ row }) => (
          <Badge variant="outline">
            {t(`notes.status.${row.original.status}`)}
          </Badge>
        ),
      },
      {
        id: 'tags',
        accessorFn: (note) => note.tags?.map((tag) => tag.name).join(', '),
        ...header('tags'),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.tags?.map((tag) => (
              <TagBadge key={tag.id} tag={tag} />
            ))}
          </div>
        ),
      },
      {
        id: 'createdAt',
        accessorFn: (note) => date(note.createdAt),
        ...header('createdAt'),
      },
      {
        id: 'publishedAt',
        accessorFn: (note) => date(note.publishedAt),
        ...header('publishedAt'),
      },
    ];
  }, [t, i18n.language]);

  return (
    <ListPage
      subject="Note"
      path="/v1/notes"
      title={t('notes.title')}
      columns={columns}
    />
  );
}
