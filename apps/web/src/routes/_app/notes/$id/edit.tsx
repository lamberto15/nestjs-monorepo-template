import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RecordState } from '@/components/records/record-state';
import { noteQuery } from '@/features/notes/api';
import { NoteForm } from '@/features/notes/note-form';
import { useRecordCan } from '@/lib/records';

export const Route = createFileRoute('/_app/notes/$id/edit')({
  beforeLoad: ({ context, params }) => {
    if (!context.me.can['Note.update']) {
      throw redirect({ to: '/notes/$id', params });
    }
  },
  component: EditNote,
});

function EditNote() {
  const { id } = Route.useParams();
  const { t } = useTranslation('notes');
  const canOf = useRecordCan('Note');
  // The form is made from one read and sent back with its ETag: a refetch in
  // the background (focus, reconnect) must not replace it under the user's
  // typing. Reloading after a 412 is the one refetch, and it is asked for.
  const query = useQuery({
    ...noteQuery(id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-medium">{t('edit.title')}</h1>
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
        {({ note, etag }) =>
          // The permission alone let the user in (beforeLoad); the note's own
          // `can` says whether its conditions allow it now (a published note).
          canOf(note).update ? (
            // Keyed by what was last saved, not by the ETag: that carries a
            // marker of `watching`, so a toggle changes it, and the form
            // would remount under the user's typing. A change by someone else
            // (the reload after a 412) moves `updatedAt`, so it still remounts.
            <NoteForm key={note.updatedAt} note={note} etag={etag} />
          ) : (
            <Alert role="alert">
              <LockIcon />
              <AlertTitle>{t('edit.locked.title')}</AlertTitle>
              <AlertDescription>
                <p>{t('edit.locked.description')}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  nativeButton={false}
                  render={<Link to="/notes/$id" params={{ id: note.id }} />}
                >
                  {t('edit.locked.back')}
                </Button>
              </AlertDescription>
            </Alert>
          )
        }
      </RecordState>
    </section>
  );
}
