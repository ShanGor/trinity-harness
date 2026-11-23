/* global self */
/* User-only generic notifications. Calendar content is fetched after authentication. */
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification('Trinity reminder', {
      body: 'Open your calendar to review a reminder.',
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 100) : 'calendar',
      data: { url: '/?calendar=1' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/?calendar=1'));
});
