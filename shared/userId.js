// 사용자 ID — 로그인이 없는 이 앱에서 기기(브라우저)를 구분하는 유일한 값. 서버는 이 값(X-User-Id)으로 사용자 기록을 찾습니다.
//   v2.2.2 ① 새 사용자: 암호학적 난수 128비트(crypto.getRandomValues) → 'u' + 32자(0-9 a-f)
//            예전 'u' + 8자 ID는 바꾸지 않고 그대로 씁니다(기존 시간표 · 알림 구독 · 도착 기록 그대로)
//          ② 저장 공간(localStorage)이 막힌 기기: 예전에는 모두 같은 'demo' 하나를 써서 서로의 기록이 섞일 수 있었음
//            → 쿠키가 되면 쿠키로 이어 가고, 그것도 안 되면 이 페이지(세션)에서만 쓰는 임시 ID — 'demo'는 쓰지 않음
//   화면(frontend/src/lib/api.js)은 createUserIdSource로 ID를 정하고, 서버(/api/health)는 idKind로 개수만 셉니다.

export const SHARED_ID = 'demo';               // 예전 화면이 저장 공간이 막혔을 때 보내던 공용 값
export const ID_RE = /^[\w-]{3,64}$/;          // 서버 · 쿠키 · 이어받기가 받는 모양(예전 그대로)
export const LONG_ID_RE = /^u[0-9a-f]{32}$/;   // v2.2.2 새 ID
const SHORT_ID_RE = /^u[0-9a-z]{1,10}$/;       // 예전 ID('u' + Math.random 36진수 8자)

/** ID 종류(서버 점검용 개수 세기): 'long'(v2.2.2) | 'short'(예전) | 'demo'(공용) | 'other'(테스트 · 그 밖) */
export function idKind(id) {
  const s = String(id ?? '');
  if (s === SHARED_ID) return 'demo';
  if (LONG_ID_RE.test(s)) return 'long';
  if (SHORT_ID_RE.test(s)) return 'short';
  return 'other';
}

/** 이 기기에 있던 값은 모양을 따지지 않고 그대로 씀(예전 동작 · 하위 호환) — 비었거나 'demo'만 빼고 */
const usable = (v) => typeof v === 'string' && v.length > 0 && v !== SHARED_ID;

/**
 * 새 사용자 ID: 'u' + 16바이트 난수의 16진수 32자
 * @param {(n: number) => ArrayLike<number>} [random]  n바이트 난수(브라우저: crypto.getRandomValues) — 없거나 실패하면 Math.random으로라도 32자
 */
export function newUserId(random) {
  let bytes = null;
  try { bytes = random ? Array.from(random(16) || []) : null; } catch { bytes = null; }
  if (!bytes || bytes.length < 16) bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)); // 아주 오래된 브라우저만
  return `u${bytes.slice(0, 16).map((b) => (b & 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 이 페이지에서 쓸 사용자 ID 정하기 · 기억하기. 저장 공간이 막혀 예외가 나도 멈추지 않고, 'demo'로 떨어지지 않습니다.
 *   순서: ① 이 기기 저장 공간(localStorage)에 있던 값(예전 8자 그대로) ② 이 페이지에서 이미 정한 값
 *        ③ 쿠키(아이폰 홈 화면 앱으로 옮겨진 경우 · 저장 공간만 막힌 경우) ④ 새로 만듦
 *   정한 값은 저장 공간 · 쿠키에 남겨 보고, 둘 다 막혔으면 이 페이지 메모리에만 둡니다(새로 열면 새 임시 ID).
 * @param {{ local: { get(): string|null, set(v: string): void }, cookie: { get(): string|null, set(v: string): void }, random?: (n: number) => ArrayLike<number> }} io
 */
export function createUserIdSource({ local, cookie, random }) {
  let current = null;   // 이 페이지에서 쓰는 ID — 같은 페이지 안에서는 늘 같은 값
  let from = null;      // 점검용: 'local' | 'cookie' | 'new' | 'handoff'
  let localSaved = false;
  let cookieFor = null; // 쿠키는 페이지마다 한 번 써서 기간을 늘림(예전과 같음) · ID가 바뀌면 다시
  const tryGet = (s) => { try { return s.get(); } catch { return undefined; } }; // undefined = 막혀서 못 읽음
  const trySet = (s, v) => { try { s.set(v); return true; } catch { return false; } };
  const touchCookie = (id) => { if (cookieFor !== id) { cookieFor = id; trySet(cookie, id); } };

  function get() {
    const stored = tryGet(local);
    if (usable(stored)) {
      if (stored !== current) from = 'local';
      current = stored; localSaved = true;
    } else {
      if (!usable(current)) {
        const c = tryGet(cookie);
        if (usable(c) && ID_RE.test(c)) { current = c; from = 'cookie'; } else { current = newUserId(random); from = 'new'; }
      }
      localSaved = stored !== undefined && trySet(local, current); // 저장 공간을 못 읽었으면 쓰지도 않음
    }
    touchCookie(current);
    return current;
  }

  return {
    get,
    /** 이어받기로 받은 ID 쓰기 — 모양이 다르거나 'demo'면 받지 않음(여러 기기가 같이 쓰던 값) */
    set(id) {
      const v = String(id ?? '');
      if (!ID_RE.test(v) || v === SHARED_ID) return false;
      current = v; from = 'handoff';
      localSaved = trySet(local, v);
      cookieFor = null; touchCookie(v);
      return true;
    },
    /** 이 기기 저장 공간에 사용자 ID가 있는지(홈 화면 앱이 처음 열릴 때는 없음) */
    hasLocal() { return usable(tryGet(local)); },
    /** 점검용: 지금 ID가 어디서 왔고 이 기기 저장 공간에 남았는지 */
    info() { return { id: current, from, localSaved, kind: current ? idKind(current) : null }; },
  };
}
