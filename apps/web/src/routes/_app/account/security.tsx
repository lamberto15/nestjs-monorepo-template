import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { z } from '@/lib/zod';
import { IdentitiesSection } from '@/components/account/identities-section';
import { MfaSection } from '@/components/account/mfa-section';
import { PasskeysSection } from '@/components/account/passkeys-section';
import { PasswordSection } from '@/components/account/password-section';
import { SessionsSection } from '@/components/account/sessions-section';
import { Feature, useMe } from '@/lib/features';

export const Route = createFileRoute('/_app/account/security')({
  validateSearch: z.object({
    // Where connecting a provider sends a refusal back (`?error=…`): the
    // codes the API uses; anything else is shown as a generic failure.
    error: z
      .enum([
        'reauthentication_required',
        'reauthentication_failed',
        'access_denied',
        'email_unverified',
        'generic',
      ])
      .optional()
      .catch('generic'),
  }),
  component: SecurityPage,
});

function SecurityPage() {
  const { t } = useTranslation();
  const me = useMe();
  const search = Route.useSearch();
  // While impersonating, the account's credentials are the user's own:
  // the API refuses changes (and hides the lists), so none are offered.
  if (me?.user.impersonator) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-xl font-medium">{t('account.security.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('account.impersonating')}
        </p>
      </div>
    );
  }
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-medium">{t('account.security.title')}</h1>
      <MfaSection />
      {!me?.mfaEnrollmentRequired && (
        <>
          <PasswordSection />
          <Feature name="passkeys">
            <PasskeysSection />
          </Feature>
          <IdentitiesSection error={search.error} />
          <SessionsSection />
        </>
      )}
    </div>
  );
}
