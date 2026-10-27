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
import { SENDER_LIMITS, type Sender } from './sender-queries';

export type SenderValues = { name: string; description: string };

/**
 * Registering a sender (no `sender`: name and description) or describing one
 * (the name is the last segment of its URL and stays). `onSubmit` throws to
 * keep the dialog open with the API's message.
 */
export function SenderFormDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sender?: Sender;
  onSubmit: (values: SenderValues) => Promise<unknown>;
}) {
  const { t } = useTranslation('webhooks');
  const [error, setError] = useState<string>();
  const editing = props.sender !== undefined;
  const form = useAppForm({
    defaultValues: {
      name: props.sender?.name ?? '',
      description: props.sender?.description ?? '',
    } satisfies SenderValues,
    validators: {
      onSubmit: z.object({
        // The API's rule for a sender's name.
        name: z
          .string()
          .trim()
          .min(1, t('senders.form.nameRequired'))
          .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, t('senders.form.nameInvalid')),
        description: z
          .string()
          .trim()
          .max(
            SENDER_LIMITS.description,
            t('senders.form.descriptionTooLong', {
              max: SENDER_LIMITS.description,
            }),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await props.onSubmit({
          name: value.name.trim(),
          description: value.description.trim(),
        });
        if (!editing) form.reset();
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
          <DialogTitle>
            {editing
              ? t('senders.form.editTitle')
              : t('senders.form.createTitle')}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? t('senders.form.editDescription')
              : t('senders.form.createDescription')}
          </DialogDescription>
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
            {!editing && (
              <form.AppField name="name">
                {(field) => (
                  <field.TextField
                    label={t('senders.form.name')}
                    description={t('senders.form.nameHint')}
                    placeholder="billing-system"
                    autoFocus
                  />
                )}
              </form.AppField>
            )}
            <form.AppField name="description">
              {(field) => (
                <field.TextField
                  label={t('senders.form.descriptionLabel')}
                  placeholder={t('senders.form.descriptionPlaceholder')}
                  autoFocus={editing}
                />
              )}
            </form.AppField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onOpenChange(false)}
              >
                {t('form.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>
                  {editing ? t('form.save') : t('senders.form.create')}
                </form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
