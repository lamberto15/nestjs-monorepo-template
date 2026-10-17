import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { RecordState } from '@/components/records/record-state';
import { noteQuery } from '@/features/notes/api';
import { NoteForm } from '@/features/notes/note-form';

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
        {({ note, etag }) => (
          // Keyed by the ETag: a reload gives the form the new version.
          <NoteForm key={etag ?? note.updatedAt} note={note} etag={etag} />
        )}
      </RecordState>
    </section>
  );
}
