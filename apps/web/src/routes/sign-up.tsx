import { createFileRoute, Link, redirect } from '@tanstack/react-router';
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
import { browserTimeZone } from '@/lib/link-token';
import { redirectSearchSchema, safeRedirect } from '@/lib/safe-redirect';
import { methodsQuery } from '@/lib/session';

// Self sign-up (AUTH_SIGN_UP=on): the account is made and a verification
// link mailed; no session until the address is proved (docs/auth.md).
export const Route = createFileRoute('/sign-up')({
  validateSearch: redirectSearchSchema,
  beforeLoad: async ({ context, search }) => {
    if (await context.session.me()) {
      throw redirect({ href: safeRedirect(search.redirect), replace: true });
    }
    const methods = await context.queryClient.ensureQueryData(methodsQuery);
    if (!methods.signUp) {
      throw redirect({ to: '/sign-in', search, replace: true });
    }
  },
  component: SignUpPage,
});

function SignUpPage() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const captcha = useCaptcha('sign-up');
  const form = useAppForm({
    defaultValues: { name: '', email: '', password: '' },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, t('auth.fields.nameRequired')).max(120),
        email: z.email(t('auth.fields.emailInvalid')),
        password: z
          .string()
          .min(12, t('auth.fields.passwordTooShort', { min: 12 }))
          .max(128),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const timezone = browserTimeZone();
      try {
        await unwrap(
          api.POST('/v1/auth/sign-up', {
            params: { header: captcha.header() },
            body: {
              ...value,
              name: value.name.trim(),
              locale: i18n.language,
              ...(timezone && { timezone }),
            },
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
      title={t('auth.signUp.title')}
      description={t('auth.signUp.description')}
    >
      {done ? (
        <LinkResult ok>{t('auth.signUp.done')}</LinkResult>
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
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label={t('auth.fields.name')}
                  autoComplete="name"
                />
              )}
            </form.AppField>
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  label={t('auth.fields.email')}
                  type="email"
                  autoComplete="email"
                />
              )}
            </form.AppField>
            <form.AppField name="password">
              {(field) => (
                <field.TextField
                  label={t('auth.fields.password')}
                  type="password"
                  autoComplete="new-password"
                  description={t('auth.fields.passwordHint')}
                />
              )}
            </form.AppField>
            {captcha.element}
            <Field>
              <form.AppForm>
                <form.SubmitButton disabled={!captcha.ready}>
                  {t('auth.signUp.submit')}
                </form.SubmitButton>
              </form.AppForm>
              <FieldDescription className="text-center">
                {t('auth.signUp.haveAccount')}{' '}
                <Link to="/sign-in" search={search}>
                  {t('auth.signIn.title')}
                </Link>
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      )}
    </AuthLayout>
  );
}
