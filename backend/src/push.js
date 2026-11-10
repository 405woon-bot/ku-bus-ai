// Web Push 발송(브라우저가 닫혀 있어도 알림). VAPID 키가 없으면 발송하지 않고 기록만 남깁니다.
import webpush from 'web-push';

export function createPusher(env = process.env, log = console) {
  const enabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (enabled) webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  return {
    enabled,
    publicKey: env.VAPID_PUBLIC_KEY || null,
    /** @returns {Promise<string[]>} 만료되어 지워야 할 구독 endpoint 목록 */
    async send(subscriptions, payload) {
      if (!enabled) { log.info?.(`[push 꺼짐] ${payload.title}`); return []; }
      const gone = [];
      await Promise.all(subscriptions.map((s) => webpush.sendNotification(s, JSON.stringify(payload), { TTL: 600, urgency: 'high' })
        .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); else log.warn?.('push 실패', e.statusCode || e.message); })));
      return gone;
    },
  };
}
