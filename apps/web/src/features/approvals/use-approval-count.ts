import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeature } from '@/lib/features';
import { useRealtimeEvent } from '@/lib/realtime';
import { approvalsKey, pendingCountQuery } from './api';

/** Without realtime nothing pushes: the count asks again this often. */
export const pollInterval = 60_000;

/**
 * The number of approvals waiting for the user: the nav badge (`NavItem.badge`).
 * With realtime on, the API's `approval.assigned` / `approval.decided` events
 * refresh the approvals queries (and the records an approval ended on); without
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
  return useQuery(pendingCountQuery(realtime ? false : pollInterval)).data;
}
