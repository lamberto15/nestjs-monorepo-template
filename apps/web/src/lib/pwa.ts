import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

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

/**
 * The browser's install prompt (web.dev, "Installation prompt"): `install`
 * is set while the browser offers one (not installed yet, a supporting
 * browser), and `install()` shows it. Safari and Firefox never fire the
 * event: nothing is offered there, the user adds the app from their menu.
 */
export function useInstallPrompt() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | undefined>();
  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Keep the event for the menu item instead of the browser's own mini-bar.
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvent(undefined);
    globalThis.addEventListener('beforeinstallprompt', onPrompt);
    globalThis.addEventListener('appinstalled', onInstalled);
    return () => {
      globalThis.removeEventListener('beforeinstallprompt', onPrompt);
      globalThis.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const install = useCallback(async () => {
    if (!event) {
      return;
    }
    await event.prompt();
    await event.userChoice;
    // The event works once, whatever the user chose.
    setEvent(undefined);
  }, [event]);
  return event ? install : undefined;
}
