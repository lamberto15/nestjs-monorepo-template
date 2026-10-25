/**
 * Tells the browser's other tabs of this origin what the session's identity
 * is now (who is signed in, in which tenant, acting as whom; `sessionIdentity`
 * in lib/session.ts). The tabs share the one `__Host-sid` cookie, so when one
 * of them re-issues it (a sign-in, `POST /v1/auth/tenant`, an impersonation,
 * sign out), the others must learn at once — not at their next stale refetch
 * of `me` (up to a minute later) — and forget the data of the previous context
 * the way the tab that switched does (lib/errors.ts's session watcher).
 *
 * BroadcastChannel only: same origin, nothing is stored anywhere, and a tab
 * without one (old browser, or jsdom) still discovers every change on its own
 * refetches — correct, just slower. Messages arriving before a tab has read
 * `me` once are of no consequence to it: read again under the new cookie.
 */
const CHANNEL = 'app-session-identity';

let channel: BroadcastChannel | undefined;
const listeners = new Set<(identity: string | null) => void>();

/** The session's identity, to every other tab of this origin. */
export function announceSessionIdentity(identity: string | null) {
  if (typeof BroadcastChannel === 'undefined') {
    return;
  }
  try {
    channel ??= new BroadcastChannel(CHANNEL);
    channel.postMessage(identity);
  } catch (error) {
    // A closed or unavailable channel is no news: every tab re-reads `me`
    // under the shared cookie anyway.
    console.warn('the session identity channel could not announce', error);
  }
}

/** The session's identity as another tab announced it. */
export function onSessionIdentity(handler: (identity: string | null) => void) {
  listeners.add(handler);
  if (typeof BroadcastChannel === 'undefined' || channel) {
    return;
  }
  try {
    channel ??= new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<string | null>) => {
      const identity = event.data ?? null;
      for (const listener of listeners) {
        listener(identity);
      }
    };
  } catch (error) {
    console.warn('the session identity channel could not be opened', error);
  }
}
