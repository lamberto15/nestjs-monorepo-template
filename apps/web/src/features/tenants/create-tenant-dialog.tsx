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
import { errorMessage, applyFieldErrors } from '@/lib/errors';
import { FormAlert, resetOnClose, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import {
  TENANT_LIMITS,
  slugify,
  slugPattern,
  type CreateTenantBody,
} from './queries';

/**
 * Name, slug and the first administrator's address: the account there is
 * made and invited when it does not exist. The slug follows the name until
 * it is typed in.
 */
export function CreateTenantDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: CreateTenantBody) => Promise<unknown>;
}) {
  const { t } = useTranslation('tenants');
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { name: '', slug: '', administratorEmail: '' },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('create.nameRequired'))
          .max(
            TENANT_LIMITS.name,
            t('create.nameTooLong', { max: TENANT_LIMITS.name }),
          ),
        slug: z
          .string()
          .max(TENANT_LIMITS.slug, t('create.slugInvalid'))
          .regex(slugPattern, t('create.slugInvalid')),
        administratorEmail: z.string().trim().email(t('create.emailInvalid')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await props.onCreate({
          name: value.name.trim(),
          slug: value.slug,
          administratorEmail: value.administratorEmail.trim(),
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
  const onOpenChange = resetOnClose(props.onOpenChange, () => {
    form.reset();
    setError(undefined);
  });
  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
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
            <form.AppField
              name="name"
              listeners={{
                onChange: ({ value }) => {
                  if (!form.getFieldMeta('slug')?.isDirty) {
                    form.setFieldValue('slug', slugify(value), {
                      dontUpdateMeta: true,
                    });
                  }
                },
              }}
            >
              {(field) => (
                <field.TextField
                  label={t('create.name')}
                  placeholder={t('create.namePlaceholder')}
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="slug">
              {(field) => (
                <field.TextField
                  label={t('create.slug')}
                  description={t('create.slugHint')}
                  placeholder="acme"
                />
              )}
            </form.AppField>
            <form.AppField name="administratorEmail">
              {(field) => (
                <field.TextField
                  label={t('create.email')}
                  description={t('create.emailHint')}
                  type="email"
                  autoComplete="off"
                />
              )}
            </form.AppField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
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
