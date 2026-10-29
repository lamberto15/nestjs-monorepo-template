// Web Push in the service worker (docs/notifications.md, "Push and SMS").
// Hand-written because Workbox's generated worker has no push handler; it is
// loaded into it with `workbox.importScripts` (vite.config.ts). The payload is
// the API's PushPayload: { id, title, body, link? }.

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // A delivery retried by the API shows once: the same tag replaces it.
      tag: payload.id,
      icon: '/pwa-192x192.png',
      data: { link: payload.link ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(
    event.notification.data?.link ?? '/',
    self.location.origin,
  );
  // Only the app's own pages: a link is a path of the web app.
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        const open = windows.find((client) => 'focus' in client);
        if (open) {
          return open.focus().then((client) => client.navigate(url.href));
        }
        return self.clients.openWindow(url.href);
      }),
  );
});
