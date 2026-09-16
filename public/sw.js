// Take over immediately on update, so a fixed worker replaces an old one without
// waiting for every tab to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* non-JSON payload, ignore */ }
  const title = data.title || 'Instantly CRM';
  // Chrome does not render SVG notification icons — these must be raster (PNG).
  const options = {
    body: data.body || 'You have a new update.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'instantly-crm-reply',
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil(
    self.registration.showNotification(title, options).catch(() =>
      // If anything about the rich notification is rejected, still surface something.
      self.registration.showNotification(title, { body: options.body })
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
