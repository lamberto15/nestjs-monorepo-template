import type { paths } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Link, createFileRoute } from '@tanstack/react-router';
import type { HeaderContext } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import {
  RecycleBinToggle,
  useRecycleBin,
} from '@/components/records/recycle-bin';
import { NOTES_PATH } from '@/features/notes/api';
import { useNoteDelete } from '@/features/notes/use-note-delete';
import { Can, useCan } from '@/lib/features';
import { useDateTimeFormat } from '@/lib/date-time';
import type { DataTableFeatures } from '@/lib/data-table-features';
import type { ListColumn } from '@/lib/list-query';

export const Route = createFileRoute('/_app/notes/')({
  component: Notes,
});

type Note =
  paths['/v1/notes']['get']['responses'][200]['content']['application/json']['items'][number];

const DELETED = { deleted: 'true' };

function Notes() {
  const { t } = useTranslation('notes');
  const date = useDateTimeFormat();
  const bin = useRecycleBin();
  const canUpdate = useCan('Note.update');
  const canDelete = useCan('Note.delete');
  const canRestore = useCan('Note.restore');
  const { ask, restore, dialog } = useNoteDelete();

  // Cells and headers only: whether a column filters or sorts, and how, comes
  // from GET /v1/lists/Note (see withListMeta).
  const columns = useMemo<ListColumn<Note>[]>(() => {
    const header = (key: string) => {
      const label = t(`columns.${key}`);
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
      {
        id: 'title',
        accessorKey: 'title',
        ...header('title'),
        // The keyboard's way in; a click anywhere on the row does the same.
        cell: ({ row }) => (
          <Link
            to="/notes/$id"
            params={{ id: row.original.id }}
            className="font-medium underline-offset-4 hover:underline"
          >
            {row.original.title}
          </Link>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        ...header('status'),
        cell: ({ row }) => (
          <Badge variant="outline">{t(`status.${row.original.status}`)}</Badge>
        ),
      },
      {
        id: 'tags',
        accessorFn: (note) => note.tags?.map((tag) => tag.name).join(', '),
        ...header('tags'),
      },
      {
        id: 'createdAt',
        accessorFn: (note) => date(note.createdAt, 'date'),
        ...header('createdAt'),
      },
      {
        id: 'publishedAt',
        accessorFn: (note) => date(note.publishedAt, 'date'),
        ...header('publishedAt'),
      },
    ];
  }, [t, date]);

  const rowActions = useCallback(
    (note: Note) => (
      <>
        <DropdownMenuItem
          render={<Link to="/notes/$id" params={{ id: note.id }} />}
        >
          {t('actions.view')}
        </DropdownMenuItem>
        {bin.deleted ? (
          canRestore && (
            <DropdownMenuItem
              onClick={() => void restore(note).catch(() => {})}
            >
              {t('actions.restore')}
            </DropdownMenuItem>
          )
        ) : (
          <>
            {canUpdate && (
              <DropdownMenuItem
                render={<Link to="/notes/$id/edit" params={{ id: note.id }} />}
              >
                {t('actions.edit')}
              </DropdownMenuItem>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => ask(note)}
                >
                  {t('actions.delete')}
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </>
    ),
    [t, bin.deleted, canUpdate, canDelete, canRestore, ask, restore],
  );

  return (
    <>
      <ListPage
        subject="Note"
        path={NOTES_PATH}
        title={bin.deleted ? t('bin.showing') : t('title')}
        columns={columns}
        query={bin.deleted ? DELETED : undefined}
        // The bin's notes are gone from the detail route (404).
        rowHref={bin.deleted ? undefined : (note) => `/notes/${note.id}`}
        rowActions={rowActions}
        toolbarActions={
          <>
            <Can permission="Note.restore">
              <RecycleBinToggle
                label={t('bin.label')}
                pressed={bin.deleted}
                onToggle={bin.toggle}
              />
            </Can>
            <Can permission="Note.create">
              <Button nativeButton={false} render={<Link to="/notes/new" />}>
                <PlusIcon />
                {t('new.action')}
              </Button>
            </Can>
          </>
        }
      />
      {dialog}
    </>
  );
}
