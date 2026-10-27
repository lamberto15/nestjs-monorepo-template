import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import { Preferences } from '@/features/settings/preferences';

export const Route = createFileRoute('/_app/account/preferences')({
  staticData: { title: 'settings:preferences.title' },
  component: PreferencesPage,
});

function PreferencesPage() {
  const { t } = useTranslation('settings');
  return (
    <Page width="narrow">
      <PageHeader title={t('preferences.title')} />
      <Preferences />
    </Page>
  );
}
