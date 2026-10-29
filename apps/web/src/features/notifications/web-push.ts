/**
 * This browser's Web Push subscription (docs/notifications.md, "Push and
 * SMS"): the service worker (vite-plugin-pwa, with public/push-sw.js) holds
 * it; the API keeps it as a device (`PUT /v1/devices`, platform `web`). The
 * device's id is remembered here so "Disable on this browser" removes the
 * right one: the API never returns a token to match it by.
 */
const DEVICE_KEY = 'web-push-device';

/** The service worker's registration, or undefined where push can't work (no worker, as under `vite dev`, or no Push API). */
export async function pushRegistration() {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return undefined;
  }
  return navigator.serviceWorker.getRegistration();
}

export function rememberedDevice() {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

export function rememberDevice(id: string | null) {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Private mode or blocked storage: removing the row in the list still works.
  }
}

/** "Firefox on Linux": what the device list shows for this browser. */
export function browserName(userAgent = navigator.userAgent) {
  const browser =
    [
      ['Edg/', 'Edge'],
      ['OPR/', 'Opera'],
      ['Firefox/', 'Firefox'],
      ['Chrome/', 'Chrome'],
      ['Safari/', 'Safari'],
    ].find(([token]) => userAgent.includes(token!))?.[1] ?? 'Browser';
  const os = [
    ['Android', 'Android'],
    ['iPhone', 'iOS'],
    ['iPad', 'iPadOS'],
    ['Mac OS X', 'macOS'],
    ['Windows', 'Windows'],
    ['Linux', 'Linux'],
  ].find(([token]) => userAgent.includes(token!))?.[1];
  return os ? `${browser} on ${os}` : browser;
}
