import {
  useQueryClient,
  type FetchQueryOptions,
  type QueryKey,
} from '@tanstack/react-query';
import { useEffect, useEffectEvent } from 'react';

/** What counts as the user being there (as `SessionIdleWarning` counts it). */
export const INPUT_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
] as const;

/** The least time between two asks that the user's input causes. */
const MIN_AGE = 60_000;

// One set of listeners on the window for every query kept fresh, whatever
// number of components ask (a nav item's hook renders again and again).
const refreshers = new Set<() => void>();
const onInput = () => {
  for (const refresh of refreshers) {
    refresh();
  }
};

function subscribe(refresh: () => void) {
  if (refreshers.size === 0) {
    for (const event of INPUT_EVENTS) {
      window.addEventListener(event, onInput, { passive: true });
    }
  }
  refreshers.add(refresh);
  return () => {
    refreshers.delete(refresh);
    if (refreshers.size === 0) {
      for (const event of INPUT_EVENTS) {
        window.removeEventListener(event, onInput);
      }
    }
  };
}

/**
 * Keeps a query of the signed-in layout fresh with no timer: it is asked again
 * when the user does something (pointer, keys, scrolling) and its answer is
 * `minAge` old or more. TanStack Query refetches on the window's focus but has
 * nothing for interaction, and a timer would defeat the idle timeout
 * (docs/auth.md, "Session lifetime"): the API counts every request as
 * activity, so an unattended tab would stay signed in for ever. `fetchQuery`
 * with a `staleTime` is the throttle: a younger answer is returned as it is,
 * without a request, and queries asked for twice share one request. A failure
 * says nothing: the answer stays as it was.
 *
 * `enabled: false` is for what something else keeps current (a realtime
 * event) or what is not asked at all.
 */
export function useRefreshOnInput<TData, TKey extends QueryKey>(
  options: FetchQueryOptions<TData, Error, TData, TKey>,
  {
    minAge = MIN_AGE,
    enabled = true,
  }: { minAge?: number; enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const refresh = useEffectEvent(() => {
    void queryClient
      .fetchQuery({
        ...options,
        staleTime: minAge,
        meta: { ...options.meta, errorToast: false },
      })
      .catch(() => undefined);
  });
  useEffect(
    () => (enabled ? subscribe(() => refresh()) : undefined),
    [enabled],
  );
}
