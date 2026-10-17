import { createFileRoute, redirect } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { AdminSettings } from '@/features/settings/admin-settings';

// Hiding the menu entry is for the user's sake; the route refuses too.
export const Route = createFileRoute('/_app/settings')({
  beforeLoad: ({ context }) => {
    if (context.me.can['Access.manageSettings'] !== true) {
      throw redirect({ to: '/' });
    }
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { t } = useTranslation('settings');
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="text-xl font-medium">{t('title')}</h1>
      <AdminSettings />
    </div>
  );
}
