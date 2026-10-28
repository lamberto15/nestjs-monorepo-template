import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, EllipsisIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import { MarkdownText } from '@/components/markdown/lazy';
import { AiPanel } from '@/features/ai/ai-panel';
import { ApprovalBanner } from '@/features/approvals/record-banner';
import { CustomFieldValues } from '@/components/records/custom-field-values';
import { DetailItem, DetailList } from '@/components/records/detail-list';
import { RecordPanels } from '@/components/records/panels/record-panels';
import { RecordState } from '@/components/records/record-state';
import { WatchButton } from '@/components/records/watch-button';
import { FavoriteButton } from '@/features/favorites/favorite-button';
import { noteQuery, setNoteWatching, type Note } from '@/features/notes/api';
import { useNoteDelete } from '@/features/notes/use-note-delete';
import { useRichText } from '@/features/notes/use-rich-text';
import { useDateTimeFormat } from '@/lib/date-time';
import { useWritesPaused } from '@/lib/mode';
import { useRecordCan } from '@/lib/records';

export const Route = createFileRoute('/_app/notes/$id/')({
  component: NoteDetail,
});

function NoteDetail() {
  const { id } = Route.useParams();
  const { t } = useTranslation('notes');
  const query = useQuery(noteQuery(id));
  return (
    <Page>
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
    </Page>
  );
}

function NoteView({ note }: { note: Note }) {
  const { t } = useTranslation('notes');
  const date = useDateTimeFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The note's own `can`: its conditions too, not only the permission.
  const { richText, pending: settingsPending } = useRichText();
  const { update: canUpdate, delete: canDelete } = useRecordCan('Note')(note);
  // Off while the API refuses writes (read-only, maintenance); the banner says why.
  const paused = useWritesPaused();
  const { ask, dialog } = useNoteDelete({
    onDeleted: () => void navigate({ to: '/notes' }),
    onRestored: (restored) =>
      void navigate({ to: '/notes/$id', params: { id: restored.id } }),
  });

  return (
    <>
      <PageHeader
        title={note.title}
        description={note.number}
        actions={
          <>
            <WatchButton
              subject="Note"
              path="/v1/notes/{id}"
              id={note.id}
              watching={note.watching}
              onToggled={(watching) =>
                setNoteWatching(queryClient, note.id, watching)
              }
            />
            <FavoriteButton
              kind="record"
              subject="Note"
              target={note.id}
              label={note.title}
            />
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
                      disabled={paused}
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
                      disabled={paused}
                      onClick={() => ask(note)}
                    >
                      {t('actions.delete')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />
      <ApprovalBanner subject="Note" recordId={note.id} />
      <DetailList>
        <DetailItem
          label={t('columns.status')}
          value={<Badge variant="outline">{t(`status.${note.status}`)}</Badge>}
        />
        {/* `body` is left out when the user's permissions don't include the
            text: then there is no field at all, which is what undefined means. */}
        {/* With the notes.richText flag (GET /v1/settings) on, the body is
            Markdown (the same text field), rendered safely; off, plain text,
            kept as typed. */}
        <DetailItem
          label={t('fields.body')}
          value={
            note.body === undefined ? undefined : settingsPending ? (
              <Skeleton className="h-5 w-48" aria-hidden />
            ) : richText ? (
              <MarkdownText>{note.body}</MarkdownText>
            ) : (
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
      <AiPanel source="note" recordId={note.id} />
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
