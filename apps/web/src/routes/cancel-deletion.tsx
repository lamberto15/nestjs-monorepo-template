import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LinkResult, MissingToken } from '@/components/auth/link-result';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { tokenSearchSchema } from '@/lib/link-token';

// The deletion mail's cancel link: no sign-in needed (docs/auth.md, "Your
// data, your account's deletion"). A click POSTs the token.
export const Route = createFileRoute('/cancel-deletion')({
  validateSearch: tokenSearchSchema,
  component: CancelDeletionPage,
});

function CancelDeletionPage() {
  const { t } = useTranslation();
  const { token } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string }>();
  return (
    <AuthLayout
      title={t('auth.cancelDeletion.title')}
      description={t('auth.cancelDeletion.description')}
    >
      {!token ? (
        <MissingToken />
      ) : outcome ? (
        <LinkResult ok={outcome.ok}>{outcome.message}</LinkResult>
      ) : (
        <Button
          className="w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.POST('/v1/account/deletion/cancel', {
                body: { token },
              });
              setOutcome({ ok: true, message: t('auth.cancelDeletion.done') });
            } catch (caught) {
              setOutcome({ ok: false, message: errorMessage(caught) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />}
          {t('auth.cancelDeletion.submit')}
        </Button>
      )}
    </AuthLayout>
  );
}
