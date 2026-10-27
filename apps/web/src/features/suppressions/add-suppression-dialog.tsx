import { isApiError } from '@nestjs-monorepo-template/api-client';
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
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, resetOnClose, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import type { AddSuppressionBody } from './queries';

/**
 * An address to stop mail to (a `manual` entry: nothing is sent, essential
 * mail included, until it is removed) and an optional note. A 409 means the
 * address is listed already; it is said on the address field.
 */
export function AddSuppressionDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (body: AddSuppressionBody) => Promise<unknown>;
}) {
  const { t } = useTranslation('suppressions');
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { address: '', note: '' },
    validators: {
      onSubmit: z.object({
        address: z
          .string()
          .trim()
          .max(320, t('add.addressInvalid'))
          .email(t('add.addressInvalid')),
        note: z.string().trim().max(500, t('add.noteTooLong')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const note = value.note.trim();
      try {
        await props.onAdd({
          address: value.address.trim(),
          ...(note && { note }),
        });
        form.reset();
        props.onOpenChange(false);
      } catch (caught) {
        if (isApiError(caught) && caught.status === 409) {
          setError(t('add.listed'));
        } else if (!applyFieldErrors(form, caught)) {
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('add.title')}</DialogTitle>
          <DialogDescription>{t('add.description')}</DialogDescription>
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
            <form.AppField name="address">
              {(field) => (
                <field.TextField
                  label={t('add.address')}
                  type="email"
                  autoComplete="off"
                  placeholder="ada@example.com"
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="note">
              {(field) => (
                <field.TextAreaField
                  label={t('add.note')}
                  description={t('add.noteHint')}
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
                {t('add.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>{t('add.submit')}</form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
