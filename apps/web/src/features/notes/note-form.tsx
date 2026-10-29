import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from '@/lib/zod';
import { CustomFieldInputs } from '@/components/records/custom-field-inputs';
import { DuplicatesWarning } from '@/components/records/duplicates-warning';
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
import { useSubjectNamingSeries } from '@/lib/naming-series';
import { FormAlert, useAppForm } from '@/lib/form';
import { useUnsavedChangesGuard } from '@/lib/unsaved-changes';
import { focusFirstInvalid } from '@/lib/form-focus';
import {
  clearEditorDraftsForIdentity,
  discardEditorDraft,
  readEditorDraft,
  saveEditorDraft,
} from '@/lib/editor-drafts';
import { meQuery, sessionIdentity } from '@/lib/session';
import {
  isPreconditionFailed,
  recordKeys,
  useInvalidateRecords,
} from '@/lib/records';
import {
  NOTES_PATH,
  NOTE_LIMITS,
  createNote,
  readNote,
  seedCreatedNote,
  updateNote,
  type Note,
  type NoteChanges,
} from './api';
import { useRichTextOnOpen } from './use-rich-text';

type NoteDraft = {
  title: string;
  body: string;
  custom: CustomDrafts;
  base: { title: string; body: string; custom: CustomDrafts };
};
const EMPTY_FIELDS: never[] = [];
const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

function isCustomDrafts(value: unknown): value is CustomDrafts {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (draft) =>
        draft === undefined ||
        typeof draft === 'string' ||
        typeof draft === 'boolean' ||
        (Array.isArray(draft) &&
          draft.every((item) => typeof item === 'string')),
    )
  );
}

function isNoteDraft(value: unknown): value is NoteDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<NoteDraft>;
  return (
    typeof draft.title === 'string' &&
    typeof draft.body === 'string' &&
    isCustomDrafts(draft.custom) &&
    !!draft.base &&
    typeof draft.base.title === 'string' &&
    typeof draft.base.body === 'string' &&
    isCustomDrafts(draft.base.custom)
  );
}

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
  const me = queryClient.getQueryData(meQuery.queryKey);
  const identity = note ? sessionIdentity(me) : null;
  const tenantId = note ? (me?.tenant?.id ?? '') : '';
  const storedDraft =
    note && identity && tenantId
      ? readEditorDraft<NoteDraft>(identity, tenantId, note.id)
      : undefined;
  const savedDraft =
    storedDraft && isNoteDraft(storedDraft.value) ? storedDraft : undefined;
  const [draftDecision, setDraftDecision] = useState(!savedDraft);
  const [latest, setLatest] = useState<{ note: Note; etag?: string }>();
  const [latestUnavailable, setLatestUnavailable] = useState(false);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [reconcileDraft, setReconcileDraft] = useState<NoteDraft>();
  const [choices, setChoices] = useState<Record<string, 'draft' | 'server'>>(
    {},
  );
  const showBody = !note || note.body !== undefined;
  // With `notes.richText` on, the body is Markdown, edited in an editor.
  const { richText, pending: settingsPending } = useRichTextOnOpen();
  // `custom` left out of a note (field-level permissions) is not edited.
  const showCustom = !note || note.custom !== undefined;
  const definitions = useQuery({
    ...customFieldsQuery('Note'),
    enabled: showCustom,
    meta: { errorToast: false },
  });
  const fields = showCustom ? (definitions.data ?? EMPTY_FIELDS) : EMPTY_FIELDS;
  const baseline = useMemo(
    () => initialDrafts(fields, note?.custom),
    [fields, note?.custom],
  );
  const [edits, setEdits] = useState<CustomDrafts>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const drafts = useMemo(() => ({ ...baseline, ...edits }), [baseline, edits]);
  // A new note takes the subject's default series unless another is picked
  // (docs/sequences.md); the picker shows only when there is a choice.
  const namingSeries = useSubjectNamingSeries('Note');
  const series = note ? [] : (namingSeries.data ?? []);
  const [pickedSeries, setPickedSeries] = useState<string>();
  const seriesId =
    pickedSeries ?? (series.find((s) => s.isDefault) ?? series[0])?.id;

  const save = useMutation({
    mutationFn: async (values: {
      title: string;
      body: string;
      custom: Record<string, unknown>;
      namingSeriesId?: string;
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
      if (Object.keys(found).length > 0) {
        focusFirstInvalid(form);
        return;
      }
      if (note && !etag) {
        setError(t('conflict.etagUnavailable'));
        return;
      }
      try {
        const saved = await save.mutateAsync({
          title: value.title.trim(),
          body: value.body,
          custom: customBody(fields, drafts, {
            stored: note?.custom,
            baseline,
          }),
          // Only a new note, and only when the user had a choice.
          ...(series.length > 1 && seriesId && { namingSeriesId: seriesId }),
        });
        if (note && identity && tenantId) {
          discardEditorDraft(identity, tenantId, note.id);
        }
        // A new note is in no record query yet (it was just seeded).
        await (note ? invalidate() : invalidateLists());
        toast.success(note ? t('form.saved') : t('form.created'));
        // Saved: the note's page, past the unsaved-changes guard.
        await navigate({
          to: '/notes/$id',
          params: { id: saved.id },
          ignoreBlocker: true,
        });
      } catch (caught) {
        if (isPreconditionFailed(caught)) {
          await loadLatest({
            title: value.title.trim(),
            body: value.body,
            custom: drafts,
            base: {
              title: note!.title,
              body: note!.body ?? '',
              custom: baseline,
            },
          });
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
  // The custom fields and the series are kept outside the form.
  useUnsavedChangesGuard(
    form,
    Object.keys(edits).length > 0 || pickedSeries !== undefined,
  );

  const formValues = useSyncExternalStore(
    (listener) => {
      const subscription = form.baseStore.subscribe(listener);
      return () => subscription.unsubscribe();
    },
    () => form.baseStore.state.values,
    () => form.baseStore.state.values,
  );
  const hasEditorChanges =
    !!note &&
    (formValues.title !== note.title ||
      (showBody && formValues.body !== note.body) ||
      Object.keys(customBody(fields, drafts, { stored: note.custom, baseline }))
        .length > 0);
  useEffect(() => {
    if (!note || !identity || !tenantId || !draftDecision) return;
    if (!hasEditorChanges) {
      discardEditorDraft(identity, tenantId, note.id);
      return;
    }
    saveEditorDraft({
      identity,
      tenantId,
      recordId: note.id,
      value: {
        title: formValues.title,
        body: formValues.body,
        custom: drafts,
        base: { title: note.title, body: note.body ?? '', custom: baseline },
      },
    });
  }, [
    draftDecision,
    drafts,
    formValues,
    hasEditorChanges,
    identity,
    note,
    tenantId,
    baseline,
  ]);

  // On confirmed logout, remove this identity's local drafts. Switching
  // accounts or impersonating leaves them keyed to the old identity, where
  // they cannot be read or submitted; returning to that identity can recover.
  useEffect(() => {
    if (!identity) return;
    return queryClient.getQueryCache().subscribe(() => {
      const state = queryClient.getQueryState(meQuery.queryKey);
      if (state?.status === 'success' && state.data === null) {
        clearEditorDraftsForIdentity(identity);
      }
    });
  }, [identity, note, queryClient, tenantId]);

  async function loadLatest(candidate: NoteDraft) {
    if (!note) return;
    setConflict(true);
    setLatest(undefined);
    setLatestUnavailable(false);
    setReconcileDraft(candidate);
    setChoices({});
    if (identity && tenantId) {
      saveEditorDraft({
        identity,
        tenantId,
        recordId: note.id,
        value: candidate,
      });
    }
    setReloading(true);
    try {
      const fresh = await readNote(note.id);
      if (!fresh.note.can?.update) {
        setLatestUnavailable(true);
        return;
      }
      setLatest(fresh);
    } catch {
      // A 403/404 after a conflict means the latest values cannot be shown.
      // Keep the local draft, but never offer a write without a fresh ETag.
      setLatestUnavailable(true);
    } finally {
      setReloading(false);
    }
  }

  async function reconcile() {
    if (!note || !latest?.etag || !reconcileDraft) return;
    const choose = (key: string, draft: unknown, base: unknown) =>
      choices[key] ?? (sameValue(draft, base) ? 'server' : 'draft');
    const currentCustom = initialDrafts(fields, latest.note.custom);
    const mergedCustom = { ...currentCustom };
    for (const field of fields) {
      if (
        choose(
          `custom:${field.key}`,
          reconcileDraft.custom[field.key],
          reconcileDraft.base.custom[field.key],
        ) === 'draft'
      ) {
        mergedCustom[field.key] = reconcileDraft.custom[field.key];
      }
    }
    const merged = {
      title:
        choose('title', reconcileDraft.title, reconcileDraft.base.title) ===
        'server'
          ? latest.note.title
          : reconcileDraft.title,
      body:
        choose('body', reconcileDraft.body, reconcileDraft.base.body) ===
          'server' || latest.note.body === undefined
          ? (latest.note.body ?? '')
          : reconcileDraft.body,
      custom: mergedCustom,
      base: {
        title: latest.note.title,
        body: latest.note.body ?? '',
        custom: currentCustom,
      },
    };
    const changes: NoteChanges = {};
    if (merged.title !== latest.note.title) changes.title = merged.title;
    if (latest.note.body !== undefined && merged.body !== latest.note.body) {
      changes.body = merged.body;
    }
    if (latest.note.custom !== undefined) {
      const custom = customBody(fields, merged.custom, {
        stored: latest.note.custom,
        baseline: currentCustom,
      });
      if (Object.keys(custom).length) changes.custom = custom;
    }
    if (!Object.keys(changes).length) {
      discardEditorDraft(identity!, tenantId, note.id);
      await navigate({ to: '/notes/$id', params: { id: note.id } });
      return;
    }
    try {
      const saved = await updateNote(note.id, changes, latest.etag);
      discardEditorDraft(identity!, tenantId, note.id);
      await invalidate();
      toast.success(t('form.saved'));
      await navigate({ to: '/notes/$id', params: { id: saved.id } });
    } catch (caught) {
      if (isPreconditionFailed(caught)) {
        await loadLatest(merged);
      } else {
        setLatestUnavailable(true);
        setError(errorMessage(caught));
      }
    }
  }

  async function recoverDraft() {
    if (!note || !identity || !tenantId || !savedDraft) return;
    setRecoveryUnavailable(false);
    try {
      const fresh = await readNote(note.id);
      if (
        !fresh.note.can?.update ||
        sessionIdentity(queryClient.getQueryData(meQuery.queryKey)) !==
          identity ||
        queryClient.getQueryData(meQuery.queryKey)?.tenant?.id !== tenantId
      ) {
        setRecoveryUnavailable(true);
        return;
      }
      form.setFieldValue('title', savedDraft.value.title);
      form.setFieldValue('body', savedDraft.value.body);
      setEdits(savedDraft.value.custom);
      setDraftDecision(true);
    } catch {
      setRecoveryUnavailable(true);
    }
  }

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
        <section
          className="rounded-md border p-4"
          aria-label={t('conflict.title')}
        >
          <h2 className="font-medium">{t('conflict.title')}</h2>
          {reloading ? <p role="status">{t('conflict.loading')}</p> : null}
          {latestUnavailable && <p role="alert">{t('conflict.unavailable')}</p>}
          {latest && reconcileDraft && (
            <div className="mt-3 flex flex-col gap-3">
              <p>{t('conflict.reconcileHint')}</p>
              {[
                {
                  key: 'title',
                  label: t('form.title'),
                  server: latest.note.title,
                  draft: reconcileDraft.title,
                  base: reconcileDraft.base.title,
                },
                ...(latest.note.body === undefined
                  ? []
                  : [
                      {
                        key: 'body',
                        label: t('form.body'),
                        server: latest.note.body,
                        draft: reconcileDraft.body,
                        base: reconcileDraft.base.body,
                      },
                    ]),
                ...fields
                  .filter(
                    (field) => latest.note.custom?.[field.key] !== undefined,
                  )
                  .map((field) => ({
                    key: `custom:${field.key}`,
                    label: field.label,
                    server: String(
                      initialDrafts(fields, latest.note.custom)[field.key] ??
                        '',
                    ),
                    draft: String(reconcileDraft.custom[field.key] ?? ''),
                    base: String(reconcileDraft.base.custom[field.key] ?? ''),
                  })),
              ]
                .filter((field) => field.server !== field.draft)
                .map((field) => (
                  <div key={field.key} className="rounded border p-3">
                    <h3 className="font-medium">{field.label}</h3>
                    <p className="text-sm">
                      {t('conflict.serverValue')}:{' '}
                      <span className="whitespace-pre-wrap">
                        {field.server || t('conflict.empty')}
                      </span>
                    </p>
                    <p className="text-sm">
                      {t('conflict.yourValue')}:{' '}
                      <span className="whitespace-pre-wrap">
                        {field.draft || t('conflict.empty')}
                      </span>
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          (choices[field.key] ??
                            (sameValue(field.draft, field.base)
                              ? 'server'
                              : 'draft')) === 'draft'
                            ? 'default'
                            : 'outline'
                        }
                        onClick={() =>
                          setChoices((old) => ({
                            ...old,
                            [field.key]: 'draft',
                          }))
                        }
                      >
                        {t('conflict.keepDraft')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          (choices[field.key] ??
                            (sameValue(field.draft, field.base)
                              ? 'server'
                              : 'draft')) === 'server'
                            ? 'default'
                            : 'outline'
                        }
                        onClick={() =>
                          setChoices((old) => ({
                            ...old,
                            [field.key]: 'server',
                          }))
                        }
                      >
                        {t('conflict.useServer')}
                      </Button>
                    </div>
                  </div>
                ))}
              <Button
                type="button"
                disabled={!latest.etag || reloading}
                onClick={() => void reconcile()}
              >
                {t('conflict.saveReconciled')}
              </Button>
            </div>
          )}
          {!latest && !reloading && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void loadLatest(
                  reconcileDraft ?? {
                    title: formValues.title,
                    body: formValues.body,
                    custom: drafts,
                    base: {
                      title: note?.title ?? '',
                      body: note?.body ?? '',
                      custom: baseline,
                    },
                  },
                )
              }
            >
              {t('conflict.retry')}
            </Button>
          )}
        </section>
      )}
      {savedDraft && !draftDecision && (
        <section
          className="rounded-md border p-4"
          aria-label={t('draft.recoveryTitle')}
        >
          <p>{t('draft.recoveryDescription')}</p>
          {recoveryUnavailable && <p role="alert">{t('draft.unavailable')}</p>}
          <div className="mt-2 flex gap-2">
            <Button type="button" onClick={() => void recoverDraft()}>
              {t('draft.recover')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                discardEditorDraft(identity!, tenantId, note!.id);
                setDraftDecision(true);
              }}
            >
              {t('draft.discard')}
            </Button>
          </div>
        </section>
      )}
      <FormAlert message={error} />
      <FieldGroup>
        <form.AppField name="title">
          {(field) => <field.TextField label={t('form.title')} autoFocus />}
        </form.AppField>
        {/* Likely duplicates of what is typed: a hint, never a block (docs/merging.md). */}
        <form.Subscribe selector={(state) => state.values.title}>
          {(title) => (
            <DuplicatesWarning
              subject="Note"
              listPath={NOTES_PATH}
              values={{ title }}
              excludeId={note?.id}
            />
          )}
        </form.Subscribe>
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
        {series.length > 1 && (
          <Field>
            <FieldLabel htmlFor="note-numbering">
              {t('form.numbering')}
            </FieldLabel>
            <Select
              items={series.map((s) => ({
                value: s.id,
                label: `${s.label ?? s.pattern} (${s.example})`,
              }))}
              value={seriesId}
              onValueChange={(next) => next && setPickedSeries(next)}
            >
              <SelectTrigger id="note-numbering" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {series.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label ?? s.pattern} ({s.example})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{t('form.numberingHint')}</FieldDescription>
          </Field>
        )}
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
          <form.SubmitButton
            disabled={!draftDecision || conflict || latestUnavailable}
          >
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
