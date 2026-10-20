import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from '@/lib/zod';
import { ConflictAlert } from '@/components/records/conflict-alert';
import { CustomFieldInputs } from '@/components/records/custom-field-inputs';
import { customFieldsQuery } from '@/lib/custom-fields';
import {
  customBody,
  draftErrors,
  initialDrafts,
  serverErrors,
  type CustomDrafts,
} from '@/lib/custom-values';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  isPreconditionFailed,
  recordKeys,
  useInvalidateRecords,
} from '@/lib/records';
import {
  NOTES_PATH,
  NOTE_LIMITS,
  createNote,
  seedCreatedNote,
  updateNote,
  type Note,
  type NoteChanges,
} from './api';
import { useRichText } from './use-rich-text';

/**
 * Create (no `note`) or edit (`note` and the `etag` it was read with): one
 * form. The body is the API's: `title`, `body` and the `custom` values of
 * the active custom fields (docs/custom-fields.md; inputs from their definitions). A note read without its
 * `body` (field-level permissions) is edited without that field, and only
 * what changed is sent.
 */
export function NoteForm(props: { note?: Note; etag?: string }) {
  const { note, etag } = props;
  const { t } = useTranslation('notes');
  const { t: tRecords } = useTranslation('records');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRecords(NOTES_PATH);
  const invalidateLists = () =>
    queryClient.invalidateQueries({ queryKey: recordKeys.lists(NOTES_PATH) });
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const showBody = !note || note.body !== undefined;
  // With `notes.richText` on, the body is Markdown, edited in an editor.
  const { richText, pending: settingsPending } = useRichText();
  // `custom` left out of a note (field-level permissions) is not edited.
  const showCustom = !note || note.custom !== undefined;
  const definitions = useQuery({
    ...customFieldsQuery('Note'),
    enabled: showCustom,
    meta: { errorToast: false },
  });
  const fields = showCustom ? (definitions.data ?? []) : [];
  const baseline = initialDrafts(fields, note?.custom);
  const [edits, setEdits] = useState<CustomDrafts>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const drafts = { ...baseline, ...edits };

  const save = useMutation({
    mutationFn: async (values: {
      title: string;
      body: string;
      custom: Record<string, unknown>;
    }) => {
      if (!note) {
        // The created note and its ETag go to the cache: the page it opens
        // shows them without reading it again.
        const { custom, ...text } = values;
        const created = await createNote({
          ...text,
          ...(Object.keys(custom).length > 0 && { custom }),
        });
        seedCreatedNote(queryClient, created);
        return created.note;
      }
      const changes: NoteChanges = {};
      if (values.title !== note.title) changes.title = values.title;
      if (showBody && values.body !== note.body) changes.body = values.body;
      if (Object.keys(values.custom).length > 0) changes.custom = values.custom;
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
          .max(NOTE_LIMITS.title, t('form.titleTooLong')),
        body: z.string().max(NOTE_LIMITS.body, t('form.bodyTooLong')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      setConflict(false);
      const found = draftErrors(fields, drafts, tRecords);
      setCustomErrors(found);
      if (Object.keys(found).length > 0) return;
      try {
        const saved = await save.mutateAsync({
          title: value.title.trim(),
          body: value.body,
          custom: customBody(fields, drafts, {
            stored: note?.custom,
            baseline,
          }),
        });
        // A new note is in no record query yet (it was just seeded).
        await (note ? invalidate() : invalidateLists());
        toast.success(note ? t('form.saved') : t('form.created'));
        await navigate({ to: '/notes/$id', params: { id: saved.id } });
      } catch (caught) {
        if (isPreconditionFailed(caught)) {
          setConflict(true);
        } else {
          const custom = serverErrors(isApiError(caught) ? caught.errors : []);
          setCustomErrors(custom);
          const own = applyFieldErrors(form, caught);
          if (!own && Object.keys(custom).length === 0) {
            setError(errorMessage(caught));
          }
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
        {showBody &&
          (settingsPending ? (
            // The flag decides the control: not the plain one for a moment first.
            <Skeleton className="h-48 w-full" aria-hidden />
          ) : (
            <form.AppField name="body">
              {(field) =>
                richText ? (
                  <field.MarkdownField label={t('form.body')} />
                ) : (
                  <field.TextAreaField label={t('form.body')} />
                )
              }
            </form.AppField>
          ))}
        {showCustom && (
          <CustomFieldInputs
            fields={fields}
            value={drafts}
            errors={customErrors}
            onChange={(key, draft) => {
              setEdits((current) => ({ ...current, [key]: draft }));
              setCustomErrors(({ [key]: _gone, ...rest }) => rest);
            }}
          />
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
