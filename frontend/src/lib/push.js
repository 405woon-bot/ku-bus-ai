// 백그라운드 알림(Web Push): 서비스 워커 등록 · 구독 · 서버 저장 · 앱을 열 때마다 확인해 자동 재등록.
//   VAPID 공개키만 서버에서 받아 쓰고(비밀키는 서버 환경변수에만), 구독 정보는 서버(외부 DB)에 저장합니다.
import { api } from './api.js';

const WANT = 'kubusai:push'; // 이 기기에서 알림을 켠 적이 있음 → 구독이 사라지면 자동으로 다시 만듦
export const wantPush = () => { try { return localStorage.getItem(WANT) === 'on'; } catch { return false; } };
const setWant = (on) => { try { if (on) localStorage.setItem(WANT, 'on'); else localStorage.removeItem(WANT); } catch { /* 저장 불가 환경 */ } };

const b64ToU8 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const u8ToB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function notifyPermission() {
  try { return 'Notification' in window ? Notification.permission : 'unsupported'; } catch { return 'unsupported'; }
}

/** 서비스 워커 등록(알림 권한을 묻지 않음) — 앱을 열 때 미리 해 두면 '알림 켜기'가 빨라짐 */
export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { await navigator.serviceWorker.register('/sw.js'); return await navigator.serviceWorker.ready; } catch { return null; }
}

/** 지금 구독이 서버의 공개키로 만든 것인지(서버 키가 바뀌면 예전 구독으로는 못 받음) */
function sameKey(sub, publicKey) {
  const k = sub?.options?.applicationServerKey;
  if (!k) return true;
  try { return u8ToB64url(k) === String(publicKey).replace(/=+$/, ''); } catch { return true; }
}

/**
 * 이 기기의 구독을 서버와 맞춤.
 * @param {{ interactive: boolean, info: object, key?: { publicKey, enabled, configError } }} o
 *   interactive = '알림 켜기'를 눌렀음(권한은 이미 물어 둠) / 아니면 앱을 열 때의 자동 확인(권한을 묻지 않음)
 * @returns {Promise<{ state: 'on'|'off'|'denied'|'needs-tap'|'no-vapid', endpoint?, known?, renewed?, push?, error? }>}
 */
export async function syncSubscription({ interactive, info, key }) {
  const k = key || await api.pushKey();
  if (!k.enabled || !k.publicKey) return { state: 'no-vapid', error: k.configError || '서버에 푸시 키(VAPID)가 설정되지 않았어요' };
  const perm = notifyPermission();
  if (perm !== 'granted') return { state: perm === 'denied' ? 'denied' : 'off' };
  const reg = await registerWorker();
  if (!reg) throw new Error('서비스 워커를 켜지 못했어요. 페이지를 새로 열어 주세요');
  let sub = await reg.pushManager.getSubscription();
  let renewed = false;
  if (sub && !sameKey(sub, k.publicKey)) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) {
    if (!interactive && !wantPush()) return { state: 'off' };
    try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(k.publicKey) }); } catch (e) {
      if (!interactive) return { state: 'needs-tap' }; // 아이폰은 버튼을 눌러야 다시 만들 수 있을 때가 있음
      throw e;
    }
    renewed = !interactive;
  }
  const r = await api.pushSubscribe({ subscription: sub.toJSON(), device: info.label, standalone: info.standalone, auto: !interactive });
  setWant(true);
  // 서버가 이 구독을 몰랐다면(서버 기록이 지워졌거나 새로 만듦) = 자동 재등록
  return { state: 'on', endpoint: sub.endpoint, known: r.known, renewed: renewed || (!interactive && !r.known), push: r.push };
}

/**
 * '알림 켜기' 버튼: 아이폰은 버튼을 누른 그 순간에 물어야 해서(애플 규칙) 다른 일보다 먼저 권한을 물음
 */
export async function enablePush({ info, key }) {
  const perm = notifyPermission() === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') return { state: perm === 'denied' ? 'denied' : 'off' };
  return syncSubscription({ interactive: true, info, key });
}

/** 이 기기 알림 끄기: 서버에서 지우고 브라우저 구독도 해지 */
export async function disablePush() {
  setWant(false);
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) { await api.pushUnsubscribe(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
}
