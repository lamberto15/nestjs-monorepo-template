import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ConsentsSection } from '@/components/account/consents-section';
import { DeletionSection } from '@/components/account/deletion-section';
import { ExportSection } from '@/components/account/export-section';
import { useMe } from '@/lib/features';

export const Route = createFileRoute('/_app/account/privacy')({
  component: PrivacyPage,
});

/** Your data, your account's deletion, consents (docs/auth.md, `/v1/account`). */
function PrivacyPage() {
  const { t } = useTranslation('privacy');
  const me = useMe();
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {/* The person's own, across their tenants: the API refuses every
          /v1/account route while impersonating (403), so none is offered. */}
      {me?.user.impersonator ? (
        <p className="text-sm text-muted-foreground">{t('impersonating')}</p>
      ) : (
        me && (
          <>
            <ExportSection />
            <ConsentsSection />
            <DeletionSection email={me.user.email} />
          </>
        )
      )}
    </div>
  );
}
