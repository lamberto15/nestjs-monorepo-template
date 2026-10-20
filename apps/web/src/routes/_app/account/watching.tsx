import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { WatchingList } from '@/features/watching/watching-list';

export const Route = createFileRoute('/_app/account/watching')({
  component: WatchingPage,
});

function WatchingPage() {
  const { t } = useTranslation('watching');
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <WatchingList />
    </div>
  );
}
