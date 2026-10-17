import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-xl font-medium">{t('notFound.title')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('notFound.description')}
      </p>
      <Link to="/" className="text-sm underline underline-offset-4">
        {t('notFound.back')}
      </Link>
    </div>
  );
}
