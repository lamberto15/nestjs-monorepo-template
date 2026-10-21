import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { FieldDescription } from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LinkResult, MissingToken } from '@/components/auth/link-result';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { tokenSearchSchema } from '@/lib/link-token';

// The "Unsubscribe" link in the footer of notification and digest mail
// (docs/notifications.md, "Unsubscribe"): no sign-in needed. Opening the page
// changes nothing, since mail scanners follow links; only the button POSTs
// the token (RFC 8058's one-click body). The API answers every refusal
// (forged, expired, account gone) with the same 400, on purpose, so the page
// can say "invalid or expired" and no more.
export const Route = createFileRoute('/unsubscribe')({
  validateSearch: tokenSearchSchema,
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { t } = useTranslation();
  const { token } = Route.useSearch();
  const unsubscribe = useMutation({
    mutationFn: async (linkToken: string) => {
      await api.POST('/v1/notifications/unsubscribe/{token}', {
        params: { path: { token: linkToken } },
        body: { 'List-Unsubscribe': 'One-Click' },
      });
    },
    // The page shows the outcome itself, not a toast.
    meta: { errorToast: false },
  });
  const { error } = unsubscribe;
  // What the person can do next: the signed-in settings (sign-in sends them
  // back to it), where they choose each kind of mail.
  const manage = (
    <Button nativeButton={false} render={<Link to="/account/notifications" />}>
      {t('preferences.title', { ns: 'notifications' })}
    </Button>
  );
  return (
    <AuthLayout
      title={t('auth.unsubscribe.title')}
      description={t('auth.unsubscribe.description')}
    >
      {!token ? (
        <MissingToken />
      ) : unsubscribe.isSuccess ? (
        <LinkResult ok action={manage}>
          {t('auth.unsubscribe.done')}
        </LinkResult>
      ) : isApiError(error) && error.status === 400 ? (
        <LinkResult ok={false} action={manage}>
          {t('auth.unsubscribe.invalid')}
        </LinkResult>
      ) : (
        <div className="flex flex-col gap-4">
          <FieldDescription className="text-center">
            {t('auth.unsubscribe.hint')}
          </FieldDescription>
          {/* Anything else (the network, a 429, a 5xx) can be tried again. */}
          <FormAlert message={error ? errorMessage(error) : undefined} />
          <Button
            className="w-full"
            disabled={unsubscribe.isPending}
            onClick={() => unsubscribe.mutate(token)}
          >
            {unsubscribe.isPending && <Spinner />}
            {t('auth.unsubscribe.submit')}
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
