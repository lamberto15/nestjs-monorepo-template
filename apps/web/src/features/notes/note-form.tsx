import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConflictAlert } from '@/components/records/conflict-alert';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  isPreconditionFailed,
  recordKeys,
  useInvalidateRecords,
} from '@/lib/records';
import {
  NOTES_PATH,
  createNote,
  updateNote,
  type Note,
  type NoteChanges,
} from './api';

/** The API's limit (`title must be at most 200 characters long`). */
const TITLE_MAX = 200;

/**
 * Create (no `note`) or edit (`note` and the `etag` it was read with): one
 * form. The body is the API's: `title` and `body`. A note read without its
 * `body` (field-level permissions) is edited without that field, and only
 * what changed is sent.
 */
export function NoteForm(props: { note?: Note; etag?: string }) {
  const { note, etag } = props;
  const { t } = useTranslation('notes');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRecords(NOTES_PATH);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const showBody = !note || note.body !== undefined;

  const save = useMutation({
    mutationFn: async (values: { title: string; body: string }) => {
      if (!note) {
        return createNote(values);
      }
      const changes: NoteChanges = {};
      if (values.title !== note.title) changes.title = values.title;
      if (showBody && values.body !== note.body) changes.body = values.body;
      // Nothing changed: no request, no new version.
      return Object.keys(changes).length > 0
        ? updateNote(note.id, changes, etag)
        : note;
    },
    // The form shows the errors; the global handler stays quiet.
    meta: { errorToast: false },
  });

  const form = useAppForm({
    defaultValues: { title: note?.title ?? '', body: note?.body ?? '' },
    validators: {
      onSubmit: z.object({
        title: z
          .string()
          .trim()
          .min(1, t('form.titleRequired'))
          .max(TITLE_MAX, t('form.titleTooLong')),
        body: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      setConflict(false);
      try {
        const saved = await save.mutateAsync({
          title: value.title.trim(),
          body: value.body,
        });
        await invalidate();
        toast.success(note ? t('form.saved') : t('form.created'));
        await navigate({ to: '/notes/$id', params: { id: saved.id } });
      } catch (caught) {
        if (isPreconditionFailed(caught)) {
          setConflict(true);
        } else if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  // The changed note replaces this form's (the edit page keys it by ETag).
  const reload = async () => {
    if (!note) return;
    setReloading(true);
    try {
      await queryClient.refetchQueries({
        queryKey: recordKeys.detail(NOTES_PATH, note.id),
      });
    } finally {
      setReloading(false);
    }
  };

  return (
    <form
      noValidate
      className="flex max-w-2xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {conflict && (
        <ConflictAlert
          title={t('conflict.title')}
          description={t('conflict.description')}
          reload={t('conflict.reload')}
          reloading={reloading}
          onReload={() => void reload()}
        />
      )}
      <FormAlert message={error} />
      <FieldGroup>
        <form.AppField name="title">
          {(field) => <field.TextField label={t('form.title')} autoFocus />}
        </form.AppField>
        {showBody && (
          <form.AppField name="body">
            {(field) => <field.TextAreaField label={t('form.body')} />}
          </form.AppField>
        )}
      </FieldGroup>
      <div className="flex gap-2">
        <form.AppForm>
          <form.SubmitButton>
            {note ? t('form.save') : t('form.create')}
          </form.SubmitButton>
        </form.AppForm>
        <Button
          variant="outline"
          nativeButton={false}
          render={
            note ? (
              <Link to="/notes/$id" params={{ id: note.id }} />
            ) : (
              <Link to="/notes" />
            )
          }
        >
          {t('form.cancel')}
        </Button>
      </div>
    </form>
  );
}
