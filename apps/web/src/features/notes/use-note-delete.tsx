import { useTranslation } from 'react-i18next';
import { useRecordDelete } from '@/components/records/use-record-delete';
import { NOTES_PATH, deleteNote, restoreNote } from './api';

type Target = { id: string };

/** Delete a note with a confirmation and an Undo toast; restore from the bin. */
export function useNoteDelete(options?: {
  onDeleted?: (note: Target) => void;
  onRestored?: (note: Target) => void;
}) {
  const { t } = useTranslation('notes');
  return useRecordDelete<Target>({
    path: NOTES_PATH,
    remove: (note) => deleteNote(note.id),
    restore: (note) => restoreNote(note.id),
    texts: {
      title: t('delete.title'),
      description: t('delete.description'),
      confirm: t('delete.confirm'),
      deleted: t('delete.done'),
      undo: t('delete.undo'),
      restored: t('restore.done'),
    },
    ...options,
  });
}
