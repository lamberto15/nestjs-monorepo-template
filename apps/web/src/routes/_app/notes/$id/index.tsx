import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, EllipsisIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApprovalBanner } from '@/features/approvals/record-banner';
import { CustomFieldValues } from '@/components/records/custom-field-values';
import { DetailItem, DetailList } from '@/components/records/detail-list';
import { RecordPanels } from '@/components/records/panels/record-panels';
import { RecordState } from '@/components/records/record-state';
import { noteQuery, type Note } from '@/features/notes/api';
import { useNoteDelete } from '@/features/notes/use-note-delete';
import { useDateTimeFormat } from '@/lib/date-time';
import { useRecordCan } from '@/lib/records';

export const Route = createFileRoute('/_app/notes/$id/')({
  component: NoteDetail,
});

function NoteDetail() {
  const { id } = Route.useParams();
  const { t } = useTranslation('notes');
  const query = useQuery(noteQuery(id));
  return (
    <section className="flex flex-col gap-4">
      <Link
        to="/notes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon className="size-4 rtl:rotate-180" />
        {t('detail.back')}
      </Link>
      <RecordState
        query={query}
        notFound={{
          title: t('notFound.title'),
          description: t('notFound.description'),
        }}
        error={{
          title: t('error.title'),
          generic: t('error.generic'),
          retry: t('error.retry'),
        }}
      >
        {({ note }) => <NoteView note={note} />}
      </RecordState>
    </section>
  );
}

function NoteView({ note }: { note: Note }) {
  const { t } = useTranslation('notes');
  const date = useDateTimeFormat();
  const navigate = useNavigate();
  // The note's own `can`: its conditions too, not only the permission.
  const { update: canUpdate, delete: canDelete } = useRecordCan('Note')(note);
  const { ask, dialog } = useNoteDelete({
    onDeleted: () => void navigate({ to: '/notes' }),
    onRestored: (restored) =>
      void navigate({ to: '/notes/$id', params: { id: restored.id } }),
  });

  return (
    <>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-medium break-words">{note.title}</h1>
          {note.number && (
            <p className="text-sm text-muted-foreground">{note.number}</p>
          )}
        </div>
        {(canUpdate || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('actions.open')}
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canUpdate && (
                <DropdownMenuItem
                  render={
                    <Link to="/notes/$id/edit" params={{ id: note.id }} />
                  }
                >
                  {t('actions.edit')}
                </DropdownMenuItem>
              )}
              {canUpdate && canDelete && <DropdownMenuSeparator />}
              {canDelete && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => ask(note)}
                >
                  {t('actions.delete')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <ApprovalBanner subject="Note" recordId={note.id} />
      <DetailList>
        <DetailItem
          label={t('columns.status')}
          value={<Badge variant="outline">{t(`status.${note.status}`)}</Badge>}
        />
        {/* `body` is left out when the user's permissions don't include the
            text: then there is no field at all, which is what undefined means. */}
        {/* TODO(notes.richText): the setting (GET /v1/settings, a flag) lets
            the web app offer a rich text editor for bodies; until one is
            chosen the body is plain text, kept as typed. */}
        <DetailItem
          label={t('fields.body')}
          value={
            note.body === undefined ? undefined : (
              <p className="whitespace-pre-wrap">{note.body}</p>
            )
          }
        />
        <CustomFieldValues subject="Note" values={note.custom} />
        <DetailItem
          label={t('columns.createdAt')}
          value={date(note.createdAt)}
        />
        <DetailItem
          label={t('fields.updatedAt')}
          value={date(note.updatedAt)}
        />
        <DetailItem
          label={t('columns.publishedAt')}
          value={date(note.publishedAt)}
        />
      </DetailList>
      <RecordPanels
        subject="Note"
        path="/v1/notes/{id}"
        id={note.id}
        canUpdate={canUpdate}
        tags={note.tags}
      />
      {dialog}
    </>
  );
}
