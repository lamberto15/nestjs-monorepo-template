import { useFeature, useMe } from '@/lib/features';
import { pollInterval } from '@/lib/realtime';

/**
 * What the notifications UI may do now. `poll`: the interval the inbox asks
 * again at (false while the socket keeps things current). `canChange`: false
 * while an administrator impersonates, since the API refuses read, read-all,
 * delete and the preferences then (docs/notifications.md, "For clients").
 */
export function useNotificationAccess() {
  const realtime = useFeature('realtime');
  const me = useMe();
  return {
    realtime,
    poll: realtime ? (false as const) : pollInterval,
    canChange: !me?.user.impersonator,
  };
}
