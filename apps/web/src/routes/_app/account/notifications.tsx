import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import {
  DevicesSection,
  PhoneSection,
} from '@/features/notifications/phone-devices';
import { PreferencesForm } from '@/features/notifications/preferences';
import { useMe } from '@/lib/features';

export const Route = createFileRoute('/_app/account/notifications')({
  staticData: { title: 'notifications:preferences.title' },
  component: NotificationPreferencesPage,
});

function NotificationPreferencesPage() {
  const { t } = useTranslation('notifications');
  const me = useMe();
  return (
    <Page width="narrow">
      <PageHeader
        title={t('preferences.title')}
        description={t('preferences.description')}
      />
      {/* The API answers 403 for the preferences while impersonating. */}
      {me?.user.impersonator ? (
        <p className="text-sm text-muted-foreground">
          {t('preferences.impersonating')}
        </p>
      ) : (
        me && (
          <>
            <PreferencesForm />
            <PhoneSection />
            <DevicesSection />
          </>
        )
      )}
    </Page>
  );
}
