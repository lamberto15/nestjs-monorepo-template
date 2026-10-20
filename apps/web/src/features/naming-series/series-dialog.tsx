import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
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
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import type { NamingSeries, NumberedSubject } from '@/lib/naming-series';
import { z } from '@/lib/zod';
import { previewQuery, useCreateSeries, useUpdateSeries } from './api';

/** The schema's limits (`POST /v1/naming-series`). */
const LIMITS = { pattern: 60, label: 100 } as const;

/** How long a pattern rests before the API is asked what it would give. */
const PREVIEW_DELAY_MS = 300;

/**
 * The next number a pattern gives (`GET /v1/naming-series/preview`), asked
 * once the user stops typing. An invalid pattern is a 400: its message is
 * shown to the user as the API wrote it.
 */
function Preview(props: { subject: string; pattern: string }) {
  const { t } = useTranslation('naming-series');
  const [settled, setSettled] = useState(props.pattern.trim());
  useEffect(() => {
    const timer = setTimeout(
      () => setSettled(props.pattern.trim()),
      PREVIEW_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [props.pattern]);
  const preview = useQuery({
    ...previewQuery(props.subject, settled),
    enabled: !!props.subject && !!settled,
  });
  const waiting = props.pattern.trim() !== settled || preview.isFetching;
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {!props.pattern.trim() || !props.subject ? (
        t('form.previewEmpty')
      ) : preview.isError && !waiting ? (
        <span className="text-destructive">{errorMessage(preview.error)}</span>
      ) : preview.isSuccess && !waiting ? (
        t('form.previewNext', { next: preview.data.next })
      ) : (
        t('form.previewLoading')
      )}
    </p>
  );
}

/**
 * Create a series (no `series`) or change one (docs/sequences.md): its
 * pattern, label, and, on creation, whether it is the subject's default.
 * Only what changed is sent. A pattern the subject already has is a 409 shown
 * on the field; an invalid one a 400 with the field's message.
 */
export function SeriesDialog(props: {
  series?: NamingSeries;
  subjects: NumberedSubject[];
  /** The subject a new series starts with. */
  subject?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('naming-series');
  const { series, subjects } = props;
  const create = useCreateSeries();
  const update = useUpdateSeries();
  const [error, setError] = useState<string>();

  const form = useAppForm({
    defaultValues: {
      subject: series?.subject ?? props.subject ?? subjects[0]?.subject ?? '',
      pattern: series?.pattern ?? '',
      label: series?.label ?? '',
      isDefault: false,
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const pattern = value.pattern.trim();
      const label = value.label.trim();
      try {
        if (series) {
          const changes: { pattern?: string; label?: string | null } = {};
          if (pattern !== series.pattern) changes.pattern = pattern;
          if (label !== (series.label ?? '')) changes.label = label || null;
          if (Object.keys(changes).length === 0) {
            props.onOpenChange(false);
            return;
          }
          await update.mutateAsync({ id: series.id, changes });
          toast.success(t('updated', { pattern }));
        } else {
          await create.mutateAsync({
            subject: value.subject,
            pattern,
            ...(label && { label }),
            ...(value.isDefault && { isDefault: true }),
          });
          toast.success(t('created', { pattern }));
        }
        props.onOpenChange(false);
      } catch (caught) {
        if (isApiError(caught) && caught.status === 409) {
          form.setFieldMeta('pattern', (meta) => ({
            ...meta,
            isTouched: true,
            errorMap: {
              ...meta?.errorMap,
              onSubmit: {
                message: t('form.patternTaken', {
                  pattern,
                  subject: value.subject,
                }),
              },
            },
          }));
        } else if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {series ? t('form.editTitle') : t('form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('form.syntax')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            <form.Field name="subject">
              {(f) => (
                <Field>
                  <FieldLabel htmlFor="series-subject">
                    {t('form.subject')}
                  </FieldLabel>
                  <Select
                    items={subjects.map((s) => ({
                      value: s.subject,
                      label: s.subject,
                    }))}
                    value={f.state.value}
                    disabled={!!series}
                    onValueChange={(next) => next && f.handleChange(next)}
                  >
                    <SelectTrigger id="series-subject" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {subjects.map((s) => (
                        <SelectItem key={s.subject} value={s.subject}>
                          {s.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
            <form.AppField
              name="pattern"
              validators={{
                onSubmit: z
                  .string()
                  .trim()
                  .min(1, t('form.patternRequired'))
                  .max(LIMITS.pattern, t('form.patternTooLong')),
              }}
            >
              {(f) => (
                <f.TextField
                  label={t('form.pattern')}
                  placeholder="INV-.YYYY.-.MM.-.#####"
                  description={t('form.patternHint')}
                  autoFocus
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <Preview subject={values.subject} pattern={values.pattern} />
              )}
            </form.Subscribe>
            <form.AppField
              name="label"
              validators={{
                onSubmit: z.string().max(LIMITS.label, t('form.labelTooLong')),
              }}
            >
              {(f) => (
                <f.TextField
                  label={t('form.label')}
                  description={t('form.labelHint')}
                />
              )}
            </form.AppField>
            {!series && (
              <form.Field name="isDefault">
                {(f) => (
                  <Field orientation="horizontal">
                    <Checkbox
                      id="series-default"
                      checked={f.state.value}
                      onCheckedChange={(checked) => f.handleChange(!!checked)}
                    />
                    <FieldLabel htmlFor="series-default">
                      {t('form.makeDefault')}
                    </FieldLabel>
                  </Field>
                )}
              </form.Field>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              {t('form.cancel')}
            </Button>
            <form.AppForm>
              <form.SubmitButton>{t('form.save')}</form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
