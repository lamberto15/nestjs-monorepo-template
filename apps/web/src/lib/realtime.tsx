import { useQueryClient } from '@tanstack/react-query';
import {
  createRealtime,
  type Realtime,
  type RealtimeEvents,
} from '@nestjs-monorepo-template/api-client';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { useFeature, useMe } from '@/lib/features';

const RealtimeContext = createContext<Realtime | undefined>(undefined);

/**
 * The connection's identity: who, in which tenant, acting as whom, and since
 * when. A tenant switch, a re-authentication and an impersonation start or
 * stop each change one of these (the session reset refetches `me`), so the
 * socket, which carries the old session's cookie, is closed and opened anew.
 */
export function connectionKey(me: NonNullable<ReturnType<typeof useMe>>) {
  return [
    me.user.id,
    me.tenant?.id ?? '',
    me.user.impersonator?.id ?? '',
    me.authentication?.authenticatedAt ?? '',
  ].join('|');
}

/**
 * One socket per signed-in session (docs/webhooks-and-realtime.md,
 * "Realtime"), only when the deployment has `realtime` on. Mounted inside
 * the `_app` layout, so it ends with the session. On every reconnect the
 * notifications queries are refetched: events sent while offline are lost.
 * Other features read the socket with `useRealtime` / `useRealtimeEvent`.
 */
export function RealtimeProvider(props: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const enabled = useFeature('realtime');
  const me = useMe();
  const key = me ? connectionKey(me) : undefined;
  const active = enabled && key !== undefined;
  // Made (not yet connected) per session identity; the effect connects it.
  const realtime = useMemo(
    () =>
      active
        ? // Same origin (Vite's proxy, Caddy): the __Host-sid cookie rides along.
          createRealtime({
            url: globalThis.location.origin,
            socket: { autoConnect: false },
          })
        : undefined,
    // `key` is the identity this socket belongs to.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [active, key],
  );

  useEffect(() => {
    if (!realtime) {
      return;
    }
    let connectedOnce = false;
    const onConnect = () => {
      if (connectedOnce) {
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      }
      connectedOnce = true;
    };
    realtime.socket.on('connect', onConnect);
    realtime.socket.connect();
    return () => {
      realtime.socket.off('connect', onConnect);
      realtime.close();
    };
  }, [realtime, queryClient]);

  return (
    <RealtimeContext.Provider value={realtime}>
      {props.children}
    </RealtimeContext.Provider>
  );
}

/** The signed-in session's socket; undefined while connecting or when `realtime` is off. */
export function useRealtime(): Realtime | undefined {
  return useContext(RealtimeContext);
}

/**
 * Listens to one of the API's events (`RealtimeEvents`) while mounted. The
 * handler may change on every render; the subscription follows the socket.
 */
export function useRealtimeEvent<E extends keyof RealtimeEvents>(
  event: E,
  handler: RealtimeEvents[E],
) {
  const realtime = useRealtime();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!realtime) {
      return;
    }
    const forward = ((...args: unknown[]) =>
      (latest.current as (...a: unknown[]) => void)(
        ...args,
      )) as RealtimeEvents[E];
    return realtime.on(event, forward);
  }, [realtime, event]);
}
