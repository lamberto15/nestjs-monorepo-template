import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';
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
 * invalidates the list queries, so no polling of its own.
 */
export function useBreachAlerts() {
  const { canChange } = useNotificationAccess();
  const alerts = useQuery({ ...breachAlertQuery, enabled: canChange });
  return canChange
    ? (alerts.data?.items.filter(
        (item) => item.type === breachedType && !item.read,
      ) ?? [])
    : [];
}

/**
 * After the password was changed the alerts are settled: marks them read
 * (best effort: the banner hides at once; a failure only leaves it shown).
 */
export function useSettleBreachAlerts() {
  const queryClient = useQueryClient();
  const alerts = useBreachAlerts();
  return useCallback(async () => {
    if (alerts.length === 0) {
      return;
    }
    const ids = new Set(alerts.map((item) => item.id));
    markCachedRead(queryClient, (item) => ids.has(item.id));
    await Promise.allSettled(
      [...ids].map((id) =>
        api.POST('/v1/notifications/{id}/read', { params: { path: { id } } }),
      ),
    );
    await refreshNotifications(queryClient);
  }, [alerts, queryClient]);
}
