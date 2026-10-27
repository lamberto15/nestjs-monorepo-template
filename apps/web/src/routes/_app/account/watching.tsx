import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import { WatchingList } from '@/features/watching/watching-list';

export const Route = createFileRoute('/_app/account/watching')({
  staticData: { title: 'watching:title' },
  component: WatchingPage,
});

function WatchingPage() {
  const { t } = useTranslation('watching');
  return (
    <Page width="narrow">
      <PageHeader title={t('title')} description={t('description')} />
      <WatchingList />
    </Page>
  );
}
