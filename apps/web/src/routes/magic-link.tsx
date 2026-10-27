import { createFileRoute } from '@tanstack/react-router';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LinkResult, MissingToken } from '@/components/auth/link-result';
import { MfaStep } from '@/components/auth/mfa-step';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { tokenSearchSchema } from '@/lib/link-token';
import { useFinishSignIn, type SignInResult } from '@/lib/sign-in';

// The sign-in link's page: signing in takes a click, so a mail scanner that
// opens the link (and even runs its script) doesn't spend it.
export const Route = createFileRoute('/magic-link')({
  staticData: { title: 'auth.magicLink.title' },
  validateSearch: tokenSearchSchema,
  component: MagicLinkPage,
});

function MagicLinkPage() {
  const { t } = useTranslation();
  const { token } = Route.useSearch();
  const finish = useFinishSignIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [mfa, setMfa] = useState(false);

  const signedIn = async (result: SignInResult) => {
    if (result.mfaRequired) {
      setMfa(true);
      return;
    }
    // The link's redirectTo (the API keeps only a path of this app).
    await finish(undefined, result);
  };

  return (
    <AuthLayout title={t('auth.magicLink.title')}>
      {!token ? (
        <MissingToken />
      ) : mfa ? (
        <MfaStep onSignedIn={signedIn} onRestart={() => setMfa(false)} />
      ) : error ? (
        <LinkResult ok={false}>{error}</LinkResult>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-center text-sm text-muted-foreground">
            {t('auth.magicLink.landing')}
          </p>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await signedIn(
                  await unwrap(
                    api.POST('/v1/auth/magic-link/verify', { body: { token } }),
                  ),
                );
              } catch (caught) {
                setError(errorMessage(caught));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />}
            {t('auth.magicLink.continue')}
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
