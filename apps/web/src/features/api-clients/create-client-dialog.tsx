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
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';

/** Name and an optional daily quota; `onCreate` makes the client. */
export function CreateClientDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; dailyQuota?: number }) => Promise<unknown>;
}) {
  const { t } = useTranslation('api-clients');
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { name: '', dailyQuota: '' },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, t('create.nameRequired')).max(200),
        dailyQuota: z
          .string()
          .trim()
          .refine((value) => value === '' || /^[1-9]\d{0,8}$/.test(value), {
            message: t('create.quotaInvalid'),
          }),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await props.onCreate({
          name: value.name.trim(),
          ...(value.dailyQuota.trim() && {
            dailyQuota: Number(value.dailyQuota),
          }),
        });
        form.reset();
        props.onOpenChange(false);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
          <DialogDescription>{t('create.description')}</DialogDescription>
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
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label={t('create.name')}
                  placeholder={t('create.namePlaceholder')}
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="dailyQuota">
              {(field) => (
                <field.TextField
                  label={t('create.quota')}
                  description={t('create.quotaHint')}
                />
              )}
            </form.AppField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onOpenChange(false)}
              >
                {t('create.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>{t('create.submit')}</form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
