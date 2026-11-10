// 서비스 워커: 서버(Web Push)가 보낸 등교 알림을 표시하고, 누르면 앱을 엽니다.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'KU BUS AI', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'KU BUS AI', {
    body: data.body || '', tag: data.tag, renotify: true, data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow(event.notification.data?.url || '/');
  }));
});
