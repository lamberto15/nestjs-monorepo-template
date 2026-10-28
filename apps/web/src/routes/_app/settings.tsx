import { createFileRoute, redirect } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import { AdminSettings } from '@/features/settings/admin-settings';
import { ConfigBundleCard } from '@/features/settings/config-bundle';

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
  const { me } = Route.useRouteContext();
  return (
    <Page width="narrow">
      <PageHeader title={t('title')} />
      <AdminSettings />
      {/* A bundle carries roles too: both permissions (docs/settings.md). */}
      {me.can['Access.manageRoles'] === true && <ConfigBundleCard />}
    </Page>
  );
}
