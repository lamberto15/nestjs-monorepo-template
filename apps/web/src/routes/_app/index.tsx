import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

export const Route = createFileRoute('/_app/')({
  component: Dashboard,
});

function Dashboard() {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="text-xl font-medium">{t('dashboard.title')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('dashboard.description')}
      </p>
    </div>
  );
}
