import { createFileRoute } from '@tanstack/react-router';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LinkResult, MissingToken } from '@/components/auth/link-result';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { tokenSearchSchema } from '@/lib/link-token';

// The sign-up's verification link: the link proves the mailbox, the
// password proves who signed up (POST /v1/auth/email/verify { token,
// password }; docs/auth.md, "Sign-up: verify first").
export const Route = createFileRoute('/verify-email')({
  validateSearch: tokenSearchSchema,
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { t } = useTranslation();
  const { token } = Route.useSearch();
  const [error, setError] = useState<string>();
  const [verified, setVerified] = useState<string>();
  const form = useAppForm({
    defaultValues: { password: '' },
    validators: {
      onSubmit: z.object({
        password: z.string().min(1, t('auth.fields.passwordRequired')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const result = await unwrap(
          api.POST('/v1/auth/email/verify', {
            body: { token: token!, password: value.password },
          }),
        );
        setVerified(result.email);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <AuthLayout
      title={t('auth.verify.title')}
      description={t('auth.verify.description')}
    >
      {!token ? (
        <MissingToken />
      ) : verified ? (
        <LinkResult ok>{t('auth.verify.done', { email: verified })}</LinkResult>
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
                  label={t('auth.fields.password')}
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppForm>
              <form.SubmitButton>{t('auth.verify.submit')}</form.SubmitButton>
            </form.AppForm>
          </FieldGroup>
        </form>
      )}
    </AuthLayout>
  );
}
