import { reportClientError } from '@/lib/report-error';
import { reloadForBuildUpdate } from '@/lib/sw-update';

/**
 * A chunk of the build this tab started with is gone (deployed since: Caddy
 * answers 404 for a hashed file it no longer serves, and the router's code
 * splitting loads pages as chunks). Vite's documented answer is its
 * `vite:preloadError` event and a reload, here through the service worker's
 * update (lib/sw-update.ts: a plain reload can keep the old shell, and the
 * same missing chunk). Once a minute at most: a chunk still missing after
 * the reload is a real failure, left to throw to the route's error page.
 */
const RELOADED_AT = 'preload-error-reloaded-at';
const ONCE_MS = 60_000;

// Memory is the fallback for a browser that blocks storage.
let reloadedAt = 0;

function lastReload(): number {
  try {
    return Number(sessionStorage.getItem(RELOADED_AT)) || 0;
  } catch {
    return reloadedAt;
  }
}

function recordReload(now: number) {
  reloadedAt = now;
  try {
    sessionStorage.setItem(RELOADED_AT, String(now));
  } catch {
    // memory only
  }
}

/** Listens on the window; returns the removal. */
export function listenForPreloadErrors(target: Window = window) {
  const onPreloadError = (event: VitePreloadErrorEvent) => {
    reportClientError(event.payload, 'window');
    const now = Date.now();
    if (now - lastReload() < ONCE_MS) {
      return;
    }
    recordReload(now);
    // Reloading: Vite need not throw it to the page meanwhile.
    event.preventDefault();
    reloadForBuildUpdate();
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => target.removeEventListener('vite:preloadError', onPreloadError);
}
