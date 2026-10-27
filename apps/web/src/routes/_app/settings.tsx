import { createFileRoute, redirect } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
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
    <Page width="narrow">
      <PageHeader title={t('title')} />
      <AdminSettings />
    </Page>
  );
}
