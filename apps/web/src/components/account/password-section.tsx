import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from '@/lib/zod';
import { Section } from '@/components/account/section';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useSettleBreachAlerts } from '@/features/notifications/breach-alert';
import { FormAlert, useAppForm } from '@/lib/form';
import { meQuery } from '@/lib/session';

/**
 * `POST /v1/auth/password/change`: wants a recent sign-in (the dialog asks
 * when it isn't); the account's other sessions are signed out. The cached
 * `me` is refreshed: it says whether the first administrator's password step
 * (`onboardingRequired.password`) is done, which the onboarding page and the
 * `_app` guard read.
 */
export function PasswordSection() {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const settleBreachAlerts = useSettleBreachAlerts();
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: async (body: {
      currentPassword?: string;
      newPassword: string;
    }) => {
      await api.POST('/v1/auth/password/change', { body });
    },
    meta: { errorToast: false },
  });
  const form = useAppForm({
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
    validators: {
      onSubmit: z
        .object({
          currentPassword: z.string(),
          newPassword: z
            .string()
            .min(12, t('auth.fields.passwordTooShort', { min: 12 }))
            .max(128),
          confirm: z.string(),
        })
        .refine((value) => value.newPassword === value.confirm, {
          path: ['confirm'],
          message: t('auth.fields.passwordMismatch'),
        }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await change.mutateAsync({
          // An account without a password (links, providers) gets its first.
          ...(value.currentPassword && {
            currentPassword: value.currentPassword,
          }),
          newPassword: value.newPassword,
        });
        form.reset();
        toast.success(t('account.password.changed'));
        // A new password answers the breached-password alert (and its banner).
        void settleBreachAlerts();
        // Last: the onboarding page leaves this section once `me` says so.
        await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Section
      title={t('account.password.title')}
      description={t('account.password.description')}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <FormAlert message={error} />
          <form.AppField name="currentPassword">
            {(field) => (
              <field.TextField
                label={t('account.password.current')}
                type="password"
                autoComplete="current-password"
                description={t('account.password.currentHint')}
              />
            )}
          </form.AppField>
          <form.AppField name="newPassword">
            {(field) => (
              <field.TextField
                label={t('auth.fields.newPassword')}
                type="password"
                autoComplete="new-password"
                description={t('auth.fields.passwordHint')}
              />
            )}
          </form.AppField>
          <form.AppField name="confirm">
            {(field) => (
              <field.TextField
                label={t('auth.fields.confirmPassword')}
                type="password"
                autoComplete="new-password"
              />
            )}
          </form.AppField>
          <form.AppForm>
            <form.SubmitButton className="self-start">
              {t('account.password.submit')}
            </form.SubmitButton>
          </form.AppForm>
        </FieldGroup>
      </form>
    </Section>
  );
}
