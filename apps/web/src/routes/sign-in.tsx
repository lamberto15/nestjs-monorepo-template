import { createFileRoute, redirect } from '@tanstack/react-router';
import { FieldDescription } from '@nestjs-monorepo-template/ui/components/field';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LoginForm } from '@/components/login-form';
import { FormAlert } from '@/lib/form';
import { redirectSearchSchema, safeRedirect } from '@/lib/safe-redirect';

export const Route = createFileRoute('/sign-in')({
  validateSearch: redirectSearchSchema.extend({
    // Where a provider's sign-in sends a refusal back (`?error=…`).
    error: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional()
      .catch(undefined),
  }),
  beforeLoad: async ({ context, search }) => {
    if (await context.session.me()) {
      throw redirect({ href: safeRedirect(search.redirect), replace: true });
    }
  },
  component: SignInPage,
});

function SignInPage() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  return (
    <AuthLayout
      title={t('auth.signIn.title')}
      description={t('auth.signIn.description')}
      footer={
        <FieldDescription className="px-6 text-center">
          {t('auth.signIn.terms')}
        </FieldDescription>
      }
    >
      <div className="flex flex-col gap-4">
        {search.error && (
          <FormAlert
            message={t(`auth.signIn.errors.${search.error}`, {
              defaultValue: t('auth.signIn.errors.generic'),
            })}
          />
        )}
        <LoginForm redirect={search.redirect} />
      </div>
    </AuthLayout>
  );
}
