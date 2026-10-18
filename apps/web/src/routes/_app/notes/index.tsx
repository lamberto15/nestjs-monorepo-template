import type { paths } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Link, createFileRoute } from '@tanstack/react-router';
import type { HeaderContext } from '@tanstack/react-table';
import { ArchiveRestoreIcon, PlusIcon, Trash2Icon } from 'lucide-react';
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
import {
  useBulkActions,
  type BulkActionSpec,
} from '@/features/bulk/use-bulk-actions';
import { NOTES_PATH } from '@/features/notes/api';
import { ScheduleReportButton } from '@/features/reports/schedule-button';
import { exportFilters } from '@/features/transfer/api';
import { ExportButton } from '@/features/transfer/export-button';
import { ImportButton } from '@/features/transfer/import-button';
import { useNoteDelete } from '@/features/notes/use-note-delete';
import { TagBadge } from '@/lib/tags';
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

  // The selection's actions (POST /v1/notes/bulk): what the user may do here.
  const bulkSpecs = useMemo<BulkActionSpec[]>(
    () =>
      bin.deleted
        ? canRestore
          ? [
              {
                action: 'restore',
                label: t('bulk.restore'),
                icon: ArchiveRestoreIcon,
              },
            ]
          : []
        : canDelete
          ? [
              {
                action: 'delete',
                label: t('bulk.delete'),
                icon: Trash2Icon,
                confirm: true,
              },
            ]
          : [],
    [t, bin.deleted, canDelete, canRestore],
  );
  const bulk = useBulkActions('/v1/notes/bulk', bulkSpecs);

  // Export and schedule what the list shows (its filter and search); the
  // recycle bin is not exported.
  const listActions = useCallback(
    ({ params }: { params: Record<string, string> }) =>
      bin.deleted ? null : (
        <>
          <ExportButton exporter="notes" filters={exportFilters(params)} />
          <ScheduleReportButton
            exporter="notes"
            filters={exportFilters(params)}
          />
        </>
      ),
    [bin.deleted],
  );

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
        listActions={listActions}
        bulkActions={bulkSpecs.length > 0 ? bulk.render : undefined}
        toolbarActions={
          <>
            {!bin.deleted && <ImportButton importer="notes" />}
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
      {bulk.dialogs}
    </>
  );
}
