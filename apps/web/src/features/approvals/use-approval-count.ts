import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeature } from '@/lib/features';
import { useRealtimeEvent } from '@/lib/realtime';
import { recordKeys } from '@/lib/records';
import { useRefreshOnInput } from '@/lib/refresh-on-input';
import { approvalsKey, pendingCountQuery } from './api';

/**
 * The number of approvals waiting for the user: the nav badge (`NavItem.badge`).
 * With realtime on, the API's `approval.assigned` / `approval.decided` events
 * refresh the approvals queries (and the records an approval ended on),
 * `approval.applied` the request that was applied. Without it nothing pushes,
 * and no timer asks: it would keep an idle session alive (docs/auth.md,
 * "Session lifetime"). The count is asked again when the user does something
 * a minute after the last answer (`useRefreshOnInput`); either way TanStack
 * Query refetches when the window regains focus.
 */
export function useApprovalCount(): number | undefined {
  const realtime = useFeature('realtime');
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: approvalsKey });
    void queryClient.invalidateQueries({ queryKey: recordKeys.allDetails });
  };
  useRealtimeEvent('approval.assigned', refresh);
  useRealtimeEvent('approval.decided', refresh);
  // The approved outcome was applied (a note is published): `outcomeAppliedAt`
  // is set now, so that request's page and the lists drop "applying" (and the
  // abandon button), and its record shows the outcome. Other requests stay.
  useRealtimeEvent('approval.applied', (event) => {
    for (const queryKey of [
      [...approvalsKey, 'detail', event.id],
      [...approvalsKey, 'list'],
      [...approvalsKey, 'record', event.subject, event.recordId],
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    // The record itself (its key is recordKeys.detail(path, id); the path is the feature's).
    void queryClient.invalidateQueries({
      queryKey: recordKeys.allDetails,
      predicate: ({ queryKey }) => queryKey[2] === event.recordId,
    });
  });
  useRefreshOnInput(pendingCountQuery, { enabled: !realtime });
  return useQuery(pendingCountQuery).data;
}
