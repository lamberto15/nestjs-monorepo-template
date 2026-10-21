import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { featuresQuery, type Features } from '@/lib/session';

/**
 * The deployment's mode (`platform.mode` / `APP_MODE`, docs/settings.md,
 * "Maintenance and read-only mode"), as `GET /v1/features` carries it:
 * `normal`, `read-only` (the API refuses writes: 503 `read_only`) or
 * `maintenance` (it refuses nearly everything: 503 `maintenance`).
 */
export type Mode = Features['mode'];

/**
 * How often the signed-in layout asks for the mode again (ms): `restricted`
 * is the interval while the mode is not `normal`; `normal` is the least time
 * between two asks that the user's input causes (never a timer, see
 * {@link useModeWatch}).
 */
export const MODE_POLL = { normal: 60_000, restricted: 15_000 } as const;

/** What counts as the user being there (as `SessionIdleWarning` counts it). */
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * The mode the page has now: `normal` until `GET /v1/features` answered. It
 * only reads the cache (`enabled: false`): the signed-out pages use the
 * controls that ask it, and `/v1/features` is for a signed-in user. The
 * signed-in layout keeps it fresh ({@link useModeWatch}).
 */
export function useMode(): Mode {
  return (
    useQuery({
      ...featuresQuery,
      enabled: false,
      select: (features) => features.mode,
    }).data ?? 'normal'
  );
}

/**
 * Whether the API refuses writes now (`read-only`, `maintenance`): a button
 * that writes is disabled while this holds, and the banner says why. The
 * routes that stay open in both modes (`@AllowInMaintenance()`, the ops
 * routes and the operators' platform settings) are the exception: their
 * controls pass `allowInMaintenance`.
 */
export function useWritesPaused(): boolean {
  return useMode() !== 'normal';
}

/**
 * Keeps the mode fresh, once, in the signed-in layout: the API pushes nothing
 * about it. While it is not `normal`, it is asked again every 15 s (about the
 * `Retry-After` of the refusals, and the maintenance notice promises to turn
 * into the app by itself). While it is `normal`, there is no timer: it is
 * asked when the user's input comes at least a minute after the last answer,
 * when the tab returns after half a minute, and at once when a request is
 * refused with 503 `read_only` or `maintenance` (lib/errors.ts). A timer
 * would defeat the idle timeout (docs/auth.md, "Session lifetime"): the API
 * counts every request, this one too, as activity, so an unattended tab
 * would stay signed in for ever. Undefined until known.
 */
export function useModeWatch(): Mode | undefined {
  const queryClient = useQueryClient();
  useEffect(() => {
    // TanStack Query has no refetch on interaction. `fetchQuery` with a
    // `staleTime` is the throttle: an answer under a minute old is returned
    // as it is, without a request.
    const onInput = () => {
      void queryClient
        .fetchQuery({
          ...featuresQuery,
          staleTime: MODE_POLL.normal,
          meta: { errorToast: false },
        })
        .catch(() => undefined);
    };
    for (const event of INPUT_EVENTS) {
      window.addEventListener(event, onInput, { passive: true });
    }
    return () => {
      for (const event of INPUT_EVENTS) {
        window.removeEventListener(event, onInput);
      }
    };
  }, [queryClient]);
  return useQuery({
    ...featuresQuery,
    select: (features) => features.mode,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data && query.state.data.mode !== 'normal'
        ? MODE_POLL.restricted
        : false,
    // A poll that fails (the API restarting) says nothing: the banner stays as it was.
    meta: { errorToast: false },
  }).data;
}

/** A request the API refused because of the mode (503 `read_only` / `maintenance`). */
export function isModeRefusal(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 503 &&
    (error.code === 'read_only' || error.code === 'maintenance')
  );
}
