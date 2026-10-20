import { Link } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { ShieldAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useBreachAlerts } from '@/features/notifications/breach-alert';

/**
 * While the user has an unread `security.passwordBreached` notification (their
 * sign-in password turned up in a data breach): says so, and links to the
 * password change. Reading the notification or changing the password hides it.
 */
export function BreachedPasswordBanner() {
  const { t } = useTranslation('notifications');
  const alerts = useBreachAlerts();
  if (alerts.length === 0) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 bg-red-100 px-4 py-2 text-sm text-red-950 dark:bg-red-950 dark:text-red-100"
    >
      <ShieldAlertIcon className="size-4 shrink-0" />
      <span className="flex-1">{t('breach.banner')}</span>
      <Button
        size="sm"
        variant="outline"
        render={<Link to="/account/security" />}
      >
        {t('breach.action')}
      </Button>
    </div>
  );
}
