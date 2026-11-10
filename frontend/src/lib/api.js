// 백엔드 연동(빌드 모드 'api'일 때만 사용). 사용자 식별은 데모용 X-User-Id 헤더.
const USER_KEY = 'kubusai:user';
export function userId() {
  try { let id = localStorage.getItem(USER_KEY); if (!id) { id = `u${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(USER_KEY, id); } return id; } catch { return 'demo'; }
}
async function req(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-user-id': userId() }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `서버 응답 ${res.status}`);
  return j;
}
export const api = {
  me: () => req('GET', '/api/me'),
  saveTimetable: (classes) => req('PUT', '/api/me/timetable', { classes }),
  saveSettings: (patch) => req('PATCH', '/api/me/settings', patch),
  live: (ids) => req('GET', `/api/live?routes=${encodeURIComponent(ids)}`),
  plan: () => req('GET', '/api/plan'),
  health: () => req('GET', '/api/health'),
  /** 노선 경유 정류장(승차 정류장 고르기) */
  routeStations: (no, busRouteId) => req('GET', `/api/routes/${encodeURIComponent(no)}/stations${busRouteId ? `?busRouteId=${busRouteId}` : ''}`),
};

const b64ToU8 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
/** 서버 푸시 켜기: 서비스 워커 등록 → 푸시 구독 → 서버에 저장. 창이 닫혀 있어도 알림을 받습니다. */
export async function enableServerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('이 브라우저는 서버 푸시를 지원하지 않아요');
  const { publicKey, enabled } = await req('GET', '/api/push/key');
  if (!enabled || !publicKey) throw new Error('서버에 푸시 키(VAPID)가 설정되지 않았어요');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('알림 권한이 필요해요');
  const reg = await navigator.serviceWorker.register('/sw.js');
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) }));
  await req('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  return true;
}
