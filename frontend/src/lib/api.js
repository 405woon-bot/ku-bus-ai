// 백엔드 연동(실서비스 빌드). 서울시 API 키 · VAPID 비밀키 · DB 키는 서버에만 있고, 화면은 /api만 부릅니다.
import { createUserIdSource } from '@shared/userId.js';

const USER_KEY = 'kubusai:user';
const COOKIE = 'kubusai_uid';

function readCookie() {
  const m = /(?:^|;\s*)kubusai_uid=([\w-]{3,64})/.exec(document.cookie);
  return m ? m[1] : null;
}
// 쿠키에도 남겨 둠: 아이폰이 홈 화면 앱으로 쿠키를 옮겨 주는 경우 같은 사용자로 이어짐(이어받기 코드의 보조 수단)
//   · 저장 공간(localStorage)만 막힌 기기도 쿠키로 같은 사용자를 이어 감
function writeCookie(id) {
  document.cookie = `${COOKIE}=${id}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
// v2.2.2 사용자 ID(shared/userId.js): 새 사용자는 암호학적 난수 32자 · 예전 8자 ID는 그대로 ·
//   저장 공간이 막혀도 'demo'(모든 막힌 기기가 같이 쓰던 값)로 떨어지지 않고 쿠키 또는 이 페이지만의 임시 ID
const ids = createUserIdSource({
  local: { get: () => localStorage.getItem(USER_KEY), set: (v) => localStorage.setItem(USER_KEY, v) },
  cookie: { get: readCookie, set: writeCookie },
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
});
/** 이 기기(브라우저)에 저장된 사용자 ID가 있는지 — 홈 화면 앱이 처음 열릴 때는 없음 */
export function hasLocalUserId() { return ids.hasLocal(); }
/** 이어받기로 받은 사용자 ID 저장(저장 공간이 막혔으면 이 페이지 · 쿠키에) — 받았으면 true('demo' · 이상한 값은 false) */
export function setUserId(id) { return ids.set(id); }
export function userId() { return ids.get(); }
// v2.2.5 '내 데이터 모두 삭제' 중 · 뒤에는 다른 요청을 보내지 않음 — 지우는 사이 예약된 저장(시간표 · 설정 · 알림 구독)이 기록을 다시 만들지 않게
let halted = false;
export function haltRequests(on = true) { halted = Boolean(on); }
async function req(method, url, body, { auth = true, whileHalted = false, timeoutMs = 0 } = {}) {
  if (halted && !whileHalted) throw Object.assign(new Error('내 데이터를 지우는 중이에요'), { status: 0, kind: 'halted' });
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(auth ? { 'x-user-id': userId() } : {}) }, body: body ? JSON.stringify(body) : undefined, ...(ctrl ? { signal: ctrl.signal } : {}) });
  } catch (e) {
    throw Object.assign(new Error(ctrl?.signal.aborted ? '서버가 답하지 않았어요' : '인터넷 연결을 확인해 주세요'), { status: 0, kind: 'network', cause: e });
  } finally { if (timer) clearTimeout(timer); }
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
  // v2.8.0 baseRev: 화면이 받은 버전 번호 — 그사이 다른 기기가 바꿨으면 서버가 409 { kind: 'stale' }로 지금 값을 줌(없으면 예전처럼 저장)
  saveMe: (patch, baseRev) => req('PATCH', '/api/me', { ...patch, ...(Number.isInteger(baseRev) ? { baseRev } : {}) }),
  saveTimetable: (classes, baseRev) => req('PUT', '/api/me/timetable', { classes, ...(Number.isInteger(baseRev) ? { baseRev } : {}) }),
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
  // v2.2 '출발했어요!' — 누른 시각을 오늘 출발 시각으로(서버가 시각 · 수업 · 경로를 다시 확인) · 잘못 눌렀으면 지우기
  departure: (body) => req('POST', '/api/me/departure', body),
  departureUndo: (key) => req('POST', '/api/me/departure/undo', { key }),
  // v2.0 출발지 환승 경로(ODsay) — 검색은 오류 대신 { ok:false, fallback:'direct' }로 답함
  transitSearch: (body) => req('POST', '/api/transit/search', body),
  transitSave: (searchId, pathId) => req('POST', '/api/me/transit', { searchId, pathId }),
  transitMode: (mode) => req('POST', '/api/me/transit', { mode }),
  // v2.1 경로를 못 찾을 때 근처 국민대행 정류장으로 직행 안내(정류장 · 걷는 시간 · 다시 찾을 출발지)
  transitFallback: (body) => req('POST', '/api/me/transit', body),
  transitClear: () => req('POST', '/api/me/transit', { clear: true }),
  // v2.6.0 '출발했어요!' 뒤 다음 탈 환승 지하철(구간 번호 · 그 역 도착 예상 분)을 알려 주면 서버가 ±15분 · 하루 몫을 확인해 그 한 곳만
  transitLive: (mid = null) => req('GET', mid ? `/api/transit/live?next=${encodeURIComponent(mid.i)}&at=${encodeURIComponent(mid.at)}` : '/api/transit/live'),
  // 홈 화면 앱으로 설정 이어받기
  handoff: () => req('POST', '/api/me/handoff', {}),
  claimHandoff: (token) => req('POST', '/api/handoff/claim', { token }, { auth: false }), // 받기 전에는 사용자 ID를 만들지 않음
  // v2.2.5 '내 데이터 모두 삭제' — 서버가 외부 DB에서도 지운 뒤에 성공으로 답함(서버가 잠들어 있으면 깨어나는 데 걸리는 시간까지 넉넉히 45초)
  deleteMe: () => req('DELETE', '/api/me', { confirm: '삭제' }, { whileHalted: true, timeoutMs: 45000 }),
};
