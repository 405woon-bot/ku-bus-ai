// 백엔드 연동(실서비스 빌드). 서울시 API 키 · VAPID 비밀키 · DB 키는 서버에만 있고, 화면은 /api만 부릅니다.
const USER_KEY = 'kubusai:user';
const COOKIE = 'kubusai_uid';
const VALID_ID = /^[\w-]{3,64}$/;

function readCookie() {
  try { const m = /(?:^|;\s*)kubusai_uid=([\w-]{3,64})/.exec(document.cookie); return m ? m[1] : null; } catch { return null; }
}
// 쿠키에도 남겨 둠: 아이폰이 홈 화면 앱으로 쿠키를 옮겨 주는 경우 같은 사용자로 이어짐(이어받기 코드의 보조 수단)
let cookieWritten = false;
function writeCookie(id) {
  if (cookieWritten) return;
  cookieWritten = true;
  try { document.cookie = `${COOKIE}=${id}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; } catch { /* 막힌 환경 */ }
}
/** 이 기기(브라우저)에 저장된 사용자 ID가 있는지 — 홈 화면 앱이 처음 열릴 때는 없음 */
export function hasLocalUserId() { try { return Boolean(localStorage.getItem(USER_KEY)); } catch { return false; } }
/** 이어받기로 받은 사용자 ID 저장 */
export function setUserId(id) {
  if (!VALID_ID.test(String(id))) return;
  try { localStorage.setItem(USER_KEY, id); } catch { /* 저장 불가 환경 */ }
  cookieWritten = false; writeCookie(id);
}
export function userId() {
  try {
    let id = localStorage.getItem(USER_KEY);
    if (!id) {
      const c = readCookie();
      id = c || `u${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(USER_KEY, id);
    }
    writeCookie(id);
    return id;
  } catch { return 'demo'; }
}
async function req(method, url, body, { auth = true } = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(auth ? { 'x-user-id': userId() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `서버 응답 ${res.status}`), { status: res.status, kind: j.kind || null, data: j });
  return j;
}
export const api = {
  searchStops: (q) => req('GET', `/api/stops?q=${encodeURIComponent(q)}`),
  nearStops: (lat, lon) => req('GET', `/api/stops/near?lat=${lat}&lon=${lon}`),
  trips: (arsId) => req('GET', `/api/stops/${encodeURIComponent(arsId)}/trips`),
  health: () => req('GET', '/api/health'),
  searchCourses: (q) => req('GET', `/api/courses?q=${encodeURIComponent(q)}`),
  coursesMeta: () => req('GET', '/api/courses/meta'),
  me: () => req('GET', '/api/me'),
  saveMe: (patch) => req('PATCH', '/api/me', patch),
  saveTimetable: (classes) => req('PUT', '/api/me/timetable', { classes }),
  // 백그라운드 알림(Web Push)
  pushKey: () => req('GET', '/api/push/key'),
  pushSubscribe: (body) => req('POST', '/api/push/subscribe', body),
  pushUnsubscribe: (endpoint) => req('POST', '/api/push/unsubscribe', { endpoint }),
  pushStatus: (endpoint) => req('POST', '/api/push/status', { endpoint }),
  pushTest: (endpoint) => req('POST', '/api/push/test', { endpoint }),
  // '도착했어요!' — 서버가 시각을 다시 확인하고 내 걸음 반영을 배움(K•CARD+ 이미지는 보내지 않음)
  arrival: (body) => req('POST', '/api/me/arrival', body),
  arrivalUndo: (key) => req('POST', '/api/me/arrival/undo', { key }),
  personalReset: () => req('POST', '/api/me/personal/reset', {}),
  // v2.0 출발지 환승 경로(ODsay) — 검색은 오류 대신 { ok:false, fallback:'direct' }로 답함
  transitSearch: (body) => req('POST', '/api/transit/search', body),
  transitSave: (searchId, pathId) => req('POST', '/api/me/transit', { searchId, pathId }),
  transitMode: (mode) => req('POST', '/api/me/transit', { mode }),
  transitClear: () => req('POST', '/api/me/transit', { clear: true }),
  transitLive: () => req('GET', '/api/transit/live'),
  // 홈 화면 앱으로 설정 이어받기
  handoff: () => req('POST', '/api/me/handoff', {}),
  claimHandoff: (token) => req('POST', '/api/handoff/claim', { token }, { auth: false }), // 받기 전에는 사용자 ID를 만들지 않음
};
