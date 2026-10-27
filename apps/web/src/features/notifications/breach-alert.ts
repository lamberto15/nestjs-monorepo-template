import { useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useRefreshOnInput } from '@/lib/refresh-on-input';
import {
  breachAlertQuery,
  breachedType,
  markCachedRead,
  refreshNotifications,
} from './queries';
import { useNotificationAccess } from './use-notification-access';

/**
 * The unread `security.passwordBreached` notifications of the signed-in user.
 * Empty while an administrator impersonates (the alert is the user's own, and
 * credentials can't be changed then). The realtime event (or a mutation)
 * invalidates the list queries. Without realtime nothing pushes, and no timer
 * asks (it would keep an idle session alive, docs/auth.md, "Session
 * lifetime"): the alert is looked for again on the window's focus and when the
 * user does something a minute after the last answer.
 */
export function useBreachAlerts() {
  const { canChange, realtime } = useNotificationAccess();
  const alerts = useQuery({ ...breachAlertQuery, enabled: canChange });
  useRefreshOnInput(breachAlertQuery, { enabled: canChange && !realtime });
  return canChange
    ? (alerts.data?.items.filter(
        (item) => item.type === breachedType && !item.read,
      ) ?? [])
    : [];
}

/**
 * After the password was changed the alerts are settled: fetches the unread
 * ones afresh (not just what the banner holds), marks them read, and tells
 * the user when that fails (the banner then stays, and so does the alert).
 */
export function useSettleBreachAlerts() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      const { items } = await queryClient.fetchQuery({
        ...breachAlertQuery,
        staleTime: 0,
      });
      const ids = new Set(
        items.filter((item) => item.type === breachedType).map((i) => i.id),
      );
      if (ids.size === 0) {
        return;
      }
      markCachedRead(queryClient, (item) => ids.has(item.id));
      await Promise.all(
        [...ids].map((id) =>
          unwrap(
            api.POST('/v1/notifications/{id}/read', {
              params: { path: { id } },
            }),
          ),
        ),
      );
    } catch {
      toast.error(t('breach.settleFailed'));
    } finally {
      await refreshNotifications(queryClient);
    }
  }, [queryClient, t]);
}
