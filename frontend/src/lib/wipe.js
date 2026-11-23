// v2.2.5 '내 데이터 모두 삭제'(설정 › 내 데이터): 서버 기록 → (성공했을 때만) 이 기기 알림 구독 · 저장값 → 새 사용자로 처음 화면.
//   반쯤 지워진 상태가 되지 않게 순서를 지킴:
//   ① 다른 요청을 멈춤(예약된 시간표 · 설정 저장이 지운 기록을 다시 만들지 않게)
//   ② 서버에 지우기 요청(DELETE /api/me) — 서버가 외부 DB에서도 지운 뒤에 성공으로 답함. 실패하면 여기서 멈추고 이 기기 값은 그대로
//   ③ 이 기기: 알림 구독 해지(브라우저) · K•CARD+ 캡처 · 앱이 쓰는 저장값(kubusai:로 시작하는 것) · 사용자 번호 쿠키
//   ④ 주소에 ?deleted=1을 붙여 새로 엶 → 저장값이 비었으니 새 사용자 번호로 시작하고 완료 안내를 보여 줌
//   미리보기(서버 없음)는 ②를 건너뛰고 이 화면의 예시 값만 지움.
import { api, haltRequests } from './api.js';
import { deleteKCard } from './kcard.js';
import { freezeState } from './platform.js';

const PREFIX = 'kubusai:';
const COOKIE = 'kubusai_uid';
const DONE_PARAM = 'deleted';
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => { setTimeout(() => reject(new Error('timeout')), ms); })]);

/** ③ 이 기기에서 지우기 — 하나가 실패해도 나머지는 계속. 무엇을 지웠는지 돌려줌 */
export async function wipeDevice() {
  const done = { push: false, kcard: false, storage: false, cookie: false };
  try {
    const reg = 'serviceWorker' in navigator ? await withTimeout(navigator.serviceWorker.getRegistration(), 3000) : null;
    const sub = reg ? await withTimeout(reg.pushManager.getSubscription(), 3000) : null;
    if (sub) await withTimeout(sub.unsubscribe(), 3000);
    done.push = true;
  } catch { /* 알림 구독이 없거나 브라우저가 막음 — 서버 쪽 구독은 이미 지워져 알림은 오지 않음 */ }
  try { await withTimeout(deleteKCard(), 4000); done.kcard = true; } catch { /* 아래 저장값 지우기에서 한 번 더 */ }
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
    for (const k of keys) localStorage.removeItem(k);
    done.storage = true;
  } catch { /* 저장 공간이 막힌 기기 — 원래 남은 값이 없음 */ }
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
    done.cookie = true;
  } catch { /* 쿠키가 막힌 기기 */ }
  try { if (typeof indexedDB !== 'undefined' && indexedDB) indexedDB.deleteDatabase('kubusai'); } catch { /* 없음 */ }
  return done;
}

/**
 * '모두 삭제' 실행. 성공하면 화면을 새로 열어서 돌아오지 않음(돌려주는 값은 실패했을 때만 의미 있음).
 * @param {{ mode: 'api'|'sample', reload?: (url: string) => void }} o
 * @returns {Promise<{ ok: true } | { ok: false, message: string, kind?: string }>}
 */
export async function deleteMyData({ mode, reload = (url) => window.location.replace(url) }) {
  haltRequests(true);
  if (mode === 'api') {
    try { await api.deleteMe(); } catch (e) {
      haltRequests(false); // 아무것도 지우지 않았으니 앱은 그대로 계속
      return { ok: false, kind: e?.kind || 'error', message: e?.message || '서버 응답이 없어요' };
    }
  }
  // 여기부터는 서버에서 이미 지운 뒤 — 무엇이 실패해도 '못 지웠어요'로 돌아가지 않고 끝까지 진행
  freezeState();
  try { await wipeDevice(); } catch { /* 단계마다 스스로 처리함 */ }
  const url = `${window.location.pathname}?${DONE_PARAM}=1#home`;
  try { reload(url); } catch { try { window.location.href = url; } catch { /* 다음에 열 때 새 사용자로 시작 */ } }
  return { ok: true };
}

/** 앱을 열 때: 방금 '모두 삭제'로 돌아왔는지(주소의 ?deleted=1) — 주소에서는 지움(못 지우는 환경이어도 안내는 보여 줌) */
export function consumeDeletedFlag() {
  let url;
  try { url = new URL(window.location.href); } catch { return false; }
  if (url.searchParams.get(DONE_PARAM) !== '1') return false;
  try {
    url.searchParams.delete(DONE_PARAM);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch { /* 주소를 바꿀 수 없는 환경(파일로 연 미리보기 등) — 새로 고치면 안내가 한 번 더 보일 뿐 */ }
  return true;
}
