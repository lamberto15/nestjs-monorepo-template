import { createFileRoute } from '@tanstack/react-router';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from '@/lib/zod';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LinkResult, MissingToken } from '@/components/auth/link-result';
import { api } from '@/lib/api';
import { AUTH_LIMITS } from '@/lib/auth-limits';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { tokenSearchSchema } from '@/lib/link-token';

// The reset mail's link (WEB_URL/reset-password?token=…): the page POSTs the
// token with the new password, never on load (mail scanners follow links).
export const Route = createFileRoute('/reset-password')({
  validateSearch: tokenSearchSchema,
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { t } = useTranslation();
  const { token } = Route.useSearch();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const form = useAppForm({
    defaultValues: { password: '', confirm: '' },
    validators: {
      onSubmit: z
        .object({
          password: z
            .string()
            .min(
              AUTH_LIMITS.passwordMin,
              t('auth.fields.passwordTooShort', {
                min: AUTH_LIMITS.passwordMin,
              }),
            )
            .max(
              AUTH_LIMITS.passwordMax,
              t('auth.fields.passwordTooLong', {
                max: AUTH_LIMITS.passwordMax,
              }),
            ),
          confirm: z.string(),
        })
        .refine((value) => value.password === value.confirm, {
          path: ['confirm'],
          message: t('auth.fields.passwordMismatch'),
        }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await api.POST('/v1/auth/password/reset', {
          body: { token: token!, password: value.password },
        });
        setDone(true);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <AuthLayout
      title={t('auth.reset.title')}
      description={t('auth.reset.description')}
    >
      {!token ? (
        <MissingToken />
      ) : done ? (
        <LinkResult ok>{t('auth.reset.done')}</LinkResult>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            <form.AppField name="password">
              {(field) => (
                <field.TextField
                  label={t('auth.fields.newPassword')}
                  type="password"
                  autoComplete="new-password"
                  description={t('auth.fields.passwordHint')}
                  autoFocus
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
              <form.SubmitButton>{t('auth.reset.submit')}</form.SubmitButton>
            </form.AppForm>
          </FieldGroup>
        </form>
      )}
    </AuthLayout>
  );
}
