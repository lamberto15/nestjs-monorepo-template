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
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import { useReleaseHold, type LegalHold } from './api';

/**
 * Release a hold, with an optional note for the record. The records it kept
 * can be deleted and purged again; the hold stays in the list as released.
 * A 409 (released already, say in another tab) is shown in the dialog.
 */
export function ReleaseHoldDialog(props: {
  hold: LegalHold;
  onOpenChange: (open: boolean) => void;
  onReleased: () => void;
}) {
  const { t } = useTranslation('legal-holds');
  const release = useReleaseHold();
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { note: '' },
    validators: {
      onSubmit: z.object({
        note: z.string().trim().max(1000, t('release.noteTooLong')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await release.mutateAsync({
          id: props.hold.id,
          note: value.note.trim(),
        });
        toast.success(t('release.released'));
        props.onReleased();
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('release.title', { subject: props.hold.subject })}
          </DialogTitle>
          <DialogDescription>{t('release.description')}</DialogDescription>
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
            <form.AppField name="note">
              {(f) => (
                <f.TextAreaField
                  label={t('release.note')}
                  description={t('release.noteHint')}
                  rows={3}
                />
              )}
            </form.AppField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onOpenChange(false)}
              >
                {t('release.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>{t('release.submit')}</form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
