import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Preferences } from '@/features/settings/preferences';

export const Route = createFileRoute('/_app/account/preferences')({
  component: PreferencesPage,
});

function PreferencesPage() {
  const { t } = useTranslation('settings');
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-medium">{t('preferences.title')}</h1>
      <Preferences />
    </div>
  );
}
