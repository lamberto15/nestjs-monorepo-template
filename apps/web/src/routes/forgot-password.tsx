import { createFileRoute, Link } from '@tanstack/react-router';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import {
  Field,
  FieldDescription,
  FieldGroup,
} from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from '@/lib/zod';
import { AuthLayout } from '@/components/auth/auth-layout';
import { useCaptcha } from '@/components/auth/captcha';
import { LinkResult } from '@/components/auth/link-result';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';

// The answer is the same whether or not the address has an account.
export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const captcha = useCaptcha('forgot-password');
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: {
      onSubmit: z.object({ email: z.email(t('auth.fields.emailInvalid')) }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await unwrap(
          api.POST('/v1/auth/password/forgot', {
            params: { header: captcha.header() },
            body: value,
          }),
        );
        captcha.settle();
        setDone(true);
      } catch (caught) {
        if (captcha.settle(caught) || applyFieldErrors(form, caught)) {
          return;
        }
        setError(errorMessage(caught));
      }
    },
  });
  return (
    <AuthLayout
      title={t('auth.forgot.title')}
      description={t('auth.forgot.description')}
    >
      {done ? (
        <LinkResult ok>{t('auth.forgot.done')}</LinkResult>
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
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  label={t('auth.fields.email')}
                  type="email"
                  autoComplete="email"
                  autoFocus
                />
              )}
            </form.AppField>
            {captcha.element}
            <Field>
              <form.AppForm>
                <form.SubmitButton disabled={!captcha.ready}>
                  {t('auth.forgot.submit')}
                </form.SubmitButton>
              </form.AppForm>
              <FieldDescription className="text-center">
                <Link to="/sign-in">{t('auth.links.backToSignIn')}</Link>
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      )}
    </AuthLayout>
  );
}
