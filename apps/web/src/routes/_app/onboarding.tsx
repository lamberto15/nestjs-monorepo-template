import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useTranslation } from 'react-i18next';
import { MfaSection } from '@/components/account/mfa-section';
import { OnboardingEmailSection } from '@/components/account/onboarding-email-section';
import { PasskeysSection } from '@/components/account/passkeys-section';
import { PasswordSection } from '@/components/account/password-section';
import { Feature, useMe } from '@/lib/features';

// The first administrator's blocking step (docs/auth.md, "Administrator
// onboarding"): `_app` sends the user here while `me.onboardingRequired`
// is set (the API answers 403 `onboarding_required` elsewhere). Two-factor
// is offered here too: with `auth.requireMfa` it is required, and this page
// must not send the user away to enrol (the two redirects would loop).
export const Route = createFileRoute('/_app/onboarding')({
  component: OnboardingPage,
});

function OnboardingPage() {
  const { t } = useTranslation();
  const me = useMe();
  const pending = me?.onboardingRequired;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-medium">{t('onboarding.title')}</h1>
      <p className="text-sm text-muted-foreground">
        {pending ? t('onboarding.description') : t('onboarding.doneHint')}
      </p>
      {pending?.email && <OnboardingEmailSection />}
      {pending?.password && <PasswordSection />}
      {(pending || me?.mfaEnrollmentRequired) && (
        <>
          {!me?.mfaEnrollmentRequired && (
            <>
              <h2 className="text-base font-medium">
                {t('onboarding.optionalTitle')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('onboarding.optionalDescription')}
              </p>
            </>
          )}
          <MfaSection />
          {!me?.mfaEnrollmentRequired && (
            <Feature name="passkeys">
              <PasskeysSection />
            </Feature>
          )}
        </>
      )}
      {!pending && (
        <Button
          nativeButton={false}
          render={<Link to="/" />}
          className="self-start"
        >
          {t('onboarding.done')}
        </Button>
      )}
    </div>
  );
}
