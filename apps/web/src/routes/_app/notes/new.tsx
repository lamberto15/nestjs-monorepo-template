import { createFileRoute, redirect } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
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
    <Page width="narrow">
      <PageHeader title={t('new.title')} />
      <NoteForm />
    </Page>
  );
}
