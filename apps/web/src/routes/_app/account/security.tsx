import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { z } from '@/lib/zod';
import { IdentitiesSection } from '@/components/account/identities-section';
import { Page, PageHeader } from '@/components/page-header';
import { MfaSection } from '@/components/account/mfa-section';
import { PasskeysSection } from '@/components/account/passkeys-section';
import { PasswordSection } from '@/components/account/password-section';
import { SessionsSection } from '@/components/account/sessions-section';
import { Feature, useMe } from '@/lib/features';

export const Route = createFileRoute('/_app/account/security')({
  staticData: { title: 'account.security.title' },
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
      <Page width="narrow">
        <PageHeader
          title={t('account.security.title')}
          description={t('account.impersonating')}
        />
      </Page>
    );
  }
  return (
    <Page width="narrow">
      <PageHeader title={t('account.security.title')} />
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
    </Page>
  );
}
