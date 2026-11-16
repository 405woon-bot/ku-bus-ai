// 서비스 워커: 서버(Web Push)가 보낸 알림을 띄우고, '받았음'을 서버에 알리고(수신 확인), 누르면 앱을 엽니다.
//   - 알림마다 실려 오는 번호(ack)를 /api/push/ack로 보내면 설정 화면의 '확인 필요'가 '수신 확인됨'으로 바뀜
//   - 아이폰은 푸시를 받으면 반드시 알림을 띄워야 해서(조용한 푸시 금지) 항상 showNotification
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'KU BUS AI', body: event.data ? event.data.text() : '' }; }
  const show = self.registration.showNotification(data.title || 'KU BUS AI', {
    body: data.body || '', tag: data.tag || undefined, renotify: Boolean(data.tag), icon: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  });
  const ack = data.ack
    ? self.registration.pushManager.getSubscription().catch(() => null).then((sub) => fetch('/api/push/ack', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: data.ack, endpoint: sub ? sub.endpoint : null }),
    })).catch(() => {})
    : Promise.resolve();
  event.waitUntil(Promise.all([show, ack]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) {
        if (c.url !== url && 'navigate' in c) c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

// 브라우저가 구독을 바꾸면(드묾) 새 구독을 만들어 서버에 알림 — 예전 주소로 사용자를 찾음
self.addEventListener('pushsubscriptionchange', (event) => {
  const b64ToU8 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    let sub = event.newSubscription;
    if (!sub) {
      const key = await fetch('/api/push/key').then((r) => r.json());
      if (!key.enabled || !key.publicKey) return;
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key.publicKey) });
    }
    await fetch('/api/push/rotate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oldEndpoint: old ? old.endpoint : null, subscription: sub.toJSON() }),
    });
  })().catch(() => {}));
});
