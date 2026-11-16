// Web Push 발송(앱을 닫아도 알림). VAPID 키는 서버 환경변수(VAPID_PUBLIC_KEY · VAPID_PRIVATE_KEY · VAPID_SUBJECT)에만.
//   키가 없거나 형식이 틀리면 발송하지 않고(서버는 멈추지 않음) 이유를 /api/health · 설정 화면에 보여 줍니다.
import crypto from 'node:crypto';
import webpush from 'web-push';

/** 구독 주소(endpoint) → 화면에 보여 줄 짧은 기기 번호(주소 자체는 화면에 내보내지 않음) */
export const deviceId = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 10);
/** 알림 수신 확인용 번호(서비스 워커가 '받았음'을 알릴 때 씀) */
export const newAckId = () => crypto.randomBytes(9).toString('base64url');

/** 구독이 web-push로 보낼 수 있는 모양인지 */
export function validSubscription(s) {
  return Boolean(s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
    && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 100);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {object} [o.sendImpl]  테스트에서 webpush.sendNotification 대신 쓸 함수(subscription, body, options) → Promise
 */
export function createPusher(env = process.env, log = console, { sendImpl } = {}) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim(), privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim() || 'mailto:admin@example.com';
  let enabled = Boolean(publicKey && privateKey), configError = null;
  if (enabled && !sendImpl) {
    try { webpush.setVapidDetails(subject, publicKey, privateKey); } catch (e) {
      enabled = false;
      configError = `VAPID 설정 오류: ${String(e.message).slice(0, 160)} — VAPID_SUBJECT는 mailto:주소 또는 https:// 로 시작해야 하고, 키는 npx web-push generate-vapid-keys로 만든 값이어야 해요`;
      log.warn?.(`[push] ${configError}`);
    }
  }
  const send = sendImpl || ((s, body, opt) => webpush.sendNotification(s, body, opt));

  /**
   * 구독마다 보내고 결과를 돌려줌. 404 · 410 = 만료된 구독(지워야 함)
   * @returns {Promise<{ results: Array<{ endpoint, ok, status, gone, message }> }>}
   */
  async function deliver(subscriptions, payload, { ttl = 600, urgency = 'high' } = {}) {
    if (!enabled) return { results: subscriptions.map((s) => ({ endpoint: s.endpoint, ok: false, skipped: true, status: 0, gone: false, message: configError || 'VAPID 키 없음' })) };
    const body = JSON.stringify(payload);
    const results = await Promise.all(subscriptions.map(async (s) => {
      try {
        const r = await send({ endpoint: s.endpoint, keys: s.keys, expirationTime: s.expirationTime ?? null }, body, { TTL: ttl, urgency });
        return { endpoint: s.endpoint, ok: true, status: r?.statusCode ?? 201, gone: false };
      } catch (e) {
        const status = e?.statusCode || 0;
        return { endpoint: s.endpoint, ok: false, status, gone: status === 404 || status === 410, message: String(e?.body || e?.message || '').slice(0, 200) };
      }
    }));
    for (const r of results) if (!r.ok && !r.gone) log.warn?.(`[push] 실패 ${r.status} ${r.message}`);
    return { results };
  }

  return {
    get enabled() { return enabled; },
    publicKey: publicKey || null,
    configError,
    deliver,
    /** (예전 방식) 보내고 만료된 구독 endpoint 목록만 돌려줌 */
    async send(subscriptions, payload) {
      if (!enabled) { log.info?.(`[push 꺼짐] ${payload.title}`); return []; }
      const { results } = await deliver(subscriptions, payload);
      return results.filter((r) => r.gone).map((r) => r.endpoint);
    },
  };
}

/**
 * 사용자 기록에 구독 넣기/갱신(같은 주소면 갱신, 새 주소면 추가, 최대 5개). 반환: 이미 알던 구독인지
 * @param {object} u 사용자 기록  @param {object} sub 브라우저 구독(toJSON)  @param {{ device?, standalone?, now: number }} meta
 */
export function upsertSubscription(u, sub, { device, standalone, now }) {
  const i = u.push.findIndex((s) => s.endpoint === sub.endpoint);
  const known = i >= 0;
  const prev = known ? u.push[i] : null;
  const rec = {
    endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime ?? null,
    device: String(device || prev?.device || '').slice(0, 20) || null, standalone: Boolean(standalone ?? prev?.standalone),
    addedAt: prev?.addedAt || now, seenAt: now, ackAt: prev?.ackAt || null, lastOkAt: prev?.lastOkAt || null, lastStatus: prev?.lastStatus ?? null,
  };
  if (known) u.push.splice(i, 1);
  u.push.push(rec); // 최근에 본 기기가 뒤로(정리할 때 오래된 것부터 빠짐)
  if (u.push.length > 5) u.push = u.push.slice(-5);
  return { known, rec };
}

/** 화면에 보여 줄 구독 · 알림 요약(주소 · 키는 빼고) */
export function pushSummary(u, endpoint) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const dev = (s) => s && ({ id: deviceId(s.endpoint), device: s.device, standalone: s.standalone, addedAt: iso(s.addedAt), seenAt: iso(s.seenAt), ackAt: iso(s.ackAt), lastOkAt: iso(s.lastOkAt), lastStatus: s.lastStatus });
  const log = (e) => e && ({ id: e.id, kind: e.kind, title: e.title, sentAt: iso(e.sentAt), sent: e.sent, failed: e.failed, ackAt: iso(e.ackAt) });
  const last = (kind) => log([...(u.pushLog || [])].reverse().find((e) => e.kind === kind)) || null;
  return {
    count: u.push.length,
    devices: u.push.map(dev),
    device: endpoint ? dev(u.push.find((s) => s.endpoint === endpoint)) || null : null,
    lastTest: last('test'), lastAlarm: last('alarm'),
  };
}

/**
 * 알림 보내기 + 기록: 서비스 워커가 '받았음'을 알릴 번호(ack)를 실어 보내고, 결과를 구독 · 로그에 남김
 * @returns {Promise<{ id, sent, failed: Array<{status, message}>, gone }>}
 */
export async function sendAndLog(store, userId, pusher, subs, payload, { kind, now, ttl } = {}) {
  const id = newAckId();
  const { results } = await pusher.deliver(subs, { ...payload, ack: id, kind }, ttl ? { ttl } : {});
  const ok = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
  store.update(userId, (u) => {
    const gone = new Set(results.filter((r) => r.gone).map((r) => r.endpoint));
    u.push = u.push.filter((s) => !gone.has(s.endpoint));
    for (const r of results) {
      const s = u.push.find((x) => x.endpoint === r.endpoint);
      if (s) { s.lastStatus = r.status; if (r.ok) s.lastOkAt = now; }
    }
    // 한 기기로만 보낸 알림(테스트)은 받은 기기를 알 수 있게 주소를 남김(서비스 워커가 주소를 못 보내도 그 기기를 '수신 확인됨'으로)
    u.pushLog = [...(u.pushLog || []), { id, kind, title: String(payload.title || '').slice(0, 80), sentAt: now, sent: ok.length, failed: bad.length, ackAt: null, ...(subs.length === 1 ? { to: subs[0].endpoint } : {}) }];
  });
  return { id, sent: ok.length, failed: bad.map((r) => ({ status: r.status, message: r.message, skipped: Boolean(r.skipped) })), gone: results.filter((r) => r.gone).length };
}
