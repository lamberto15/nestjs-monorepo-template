import { useCallback, useSyncExternalStore } from 'react';

/** `beforeinstallprompt` (Chromium): not in lib.dom, the browser's own event. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const subscribeOnline = (notify: () => void) => {
  globalThis.addEventListener('online', notify);
  globalThis.addEventListener('offline', notify);
  return () => {
    globalThis.removeEventListener('online', notify);
    globalThis.removeEventListener('offline', notify);
  };
};

/** `navigator.onLine`, live. It is false only when the browser has no network at all. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => globalThis.navigator.onLine,
    () => true,
  );
}

let installEvent: BeforeInstallPromptEvent | undefined;
const installListeners = new Set<() => void>();

function setInstallEvent(event: BeforeInstallPromptEvent | undefined) {
  installEvent = event;
  for (const notify of installListeners) {
    notify();
  }
}

// Listened for here, at import time (main.tsx imports this module), not in
// the hook: the browser fires `beforeinstallprompt` once per page load, long
// before the signed-in layout (and the hook, in its user menu) mounts: on the
// sign-in page, or while the session loads. A listener added by the hook
// would miss it, so the event is kept in this store and the hook reads it.
globalThis.addEventListener('beforeinstallprompt', (e) => {
  // Keep the event for the menu item instead of the browser's own mini-bar.
  e.preventDefault();
  setInstallEvent(e as BeforeInstallPromptEvent);
});
globalThis.addEventListener('appinstalled', () => setInstallEvent(undefined));

const subscribeInstall = (notify: () => void) => {
  installListeners.add(notify);
  return () => {
    installListeners.delete(notify);
  };
};

/**
 * The browser's install prompt (web.dev, "Installation prompt"): `install`
 * is set while the browser offers one (not installed yet, a supporting
 * browser), and `install()` shows it. Safari and Firefox never fire the
 * event: nothing is offered there, the user adds the app from their menu.
 */
export function useInstallPrompt() {
  const event = useSyncExternalStore(
    subscribeInstall,
    () => installEvent,
    () => undefined,
  );
  const install = useCallback(async () => {
    if (!event) {
      return;
    }
    await event.prompt();
    await event.userChoice;
    // The event works once, whatever the user chose.
    if (installEvent === event) {
      setInstallEvent(undefined);
    }
  }, [event]);
  return event ? install : undefined;
}
