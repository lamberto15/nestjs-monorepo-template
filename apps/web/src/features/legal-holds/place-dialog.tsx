import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, resetOnClose, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import { SUBJECT_PATTERN, usePlaceHold } from './api';

/**
 * Place a legal hold (docs/retention.md): a permission subject, one record
 * of it (or none, to hold every record of the subject) and the reason.
 */
export function PlaceHoldDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('legal-holds');
  const place = usePlaceHold();
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { subject: '', recordId: '', reason: '' },
    validators: {
      onSubmit: z.object({
        subject: z
          .string()
          .trim()
          .regex(SUBJECT_PATTERN, t('place.subjectInvalid'))
          .max(100, t('place.subjectInvalid')),
        recordId: z.union([z.literal(''), z.uuid(t('place.recordInvalid'))]),
        reason: z
          .string()
          .trim()
          .min(1, t('place.reasonRequired'))
          .max(1000, t('place.reasonTooLong')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const recordId = value.recordId.trim();
      try {
        await place.mutateAsync({
          subject: value.subject.trim(),
          ...(recordId && { recordId }),
          reason: value.reason.trim(),
        });
        toast.success(t('place.placed'));
        form.reset();
        props.onOpenChange(false);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  const onOpenChange = resetOnClose(props.onOpenChange, () => {
    form.reset();
    setError(undefined);
  });
  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('place.title')}</DialogTitle>
          <DialogDescription>{t('place.description')}</DialogDescription>
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
            <form.AppField name="subject">
              {(f) => (
                <f.TextField
                  label={t('place.subject')}
                  description={t('place.subjectHint')}
                  placeholder="Note"
                  autoComplete="off"
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="recordId">
              {(f) => (
                <f.TextField
                  label={t('place.recordId')}
                  description={t('place.recordIdHint')}
                  autoComplete="off"
                />
              )}
            </form.AppField>
            <form.AppField name="reason">
              {(f) => (
                <f.TextAreaField
                  label={t('place.reason')}
                  description={t('place.reasonHint')}
                  rows={3}
                />
              )}
            </form.AppField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('place.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>{t('place.submit')}</form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
