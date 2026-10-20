import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeature } from '@/lib/features';
import { useRealtimeEvent } from '@/lib/realtime';
import { approvalsKey, pendingCountQuery } from './api';

/** Without realtime nothing pushes: the count asks again this often. */
export const pollInterval = 60_000;

/**
 * The number of approvals waiting for the user: the nav badge (`NavItem.badge`).
 * With realtime on, the API's `approval.assigned` / `approval.decided` events
 * refresh the approvals queries (and the records an approval ended on),
 * `approval.applied` the request that was applied; without
 * it the count is asked again every minute. Either way TanStack Query
 * refetches when the window regains focus.
 */
export function useApprovalCount(): number | undefined {
  const realtime = useFeature('realtime');
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: approvalsKey });
    void queryClient.invalidateQueries({ queryKey: ['record'] });
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
    // The record itself (its key is ['record', path, id]; the path is the feature's).
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === 'record' && queryKey[2] === event.recordId,
    });
  });
  return useQuery(pendingCountQuery(realtime ? false : pollInterval)).data;
}
