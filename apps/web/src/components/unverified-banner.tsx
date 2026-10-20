import { MailWarningIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ResendVerification,
  useUnverifiedUser,
} from '@/components/auth/resend-verification';

/**
 * While the signed-in user's address is not proved (`me.user.emailVerified`
 * false): what is missing, and the way to get the link mailed again.
 */
export function UnverifiedBanner() {
  const { t } = useTranslation();
  const user = useUnverifiedUser();
  if (!user) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      <MailWarningIcon className="size-4 shrink-0" />
      <span className="flex-1">
        {t('auth.verify.banner', { email: user.email })}
      </span>
      <ResendVerification size="sm" />
    </div>
  );
}
