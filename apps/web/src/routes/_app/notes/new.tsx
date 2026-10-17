import { createFileRoute, redirect } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { NoteForm } from '@/features/notes/note-form';

export const Route = createFileRoute('/_app/notes/new')({
  // The API refuses it anyway; a user without the permission has no use for the form.
  beforeLoad: ({ context }) => {
    if (!context.me.can['Note.create']) {
      throw redirect({ to: '/notes' });
    }
  },
  component: NewNote,
});

function NewNote() {
  const { t } = useTranslation('notes');
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-medium">{t('new.title')}</h1>
      <NoteForm />
    </section>
  );
}
