import { LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMode } from '@/lib/mode';

/**
 * While the deployment is read-only (`mode: 'read-only'` in
 * `GET /v1/features`, docs/settings.md): the API refuses every write with
 * 503 `read_only`, so say so. The controls that write are disabled
 * (`useWritesPaused`). Maintenance is not here: nothing works then, and the
 * layout shows the full-page `MaintenanceNotice` instead.
 */
export function ModeBanner() {
  const { t } = useTranslation('mode');
  if (useMode() !== 'read-only') {
    return null;
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100"
    >
      <LockIcon className="size-4 shrink-0" />
      <span>{t('readOnly.banner')}</span>
    </div>
  );
}
