import { useFeature, useMe } from '@/lib/features';

/** Without realtime nothing pushes: the count and the inbox ask again this often. */
export const pollInterval = 60_000;

/**
 * What the notifications UI may do now. `poll`: the interval to ask again at
 * (false while the socket keeps things current). `canChange`: false while an
 * administrator impersonates, since the API refuses read, read-all, delete
 * and the preferences then (docs/notifications.md, "For clients").
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
