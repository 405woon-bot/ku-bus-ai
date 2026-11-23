// v2.2.3 예전에 정밀하게 저장된 GPS 출발지를 약 100m 칸(소수 셋째 자리)으로 옮기기 — 서버가 켜질 때 한 번, 저장소를 다 읽은 뒤
//   · 사용자 기록: transit.origin · transit.retry.origin 중 GPS로 고른 것(kind 'gps')의 위도 · 경도만 반올림
//     — 이름으로 고른 역 · 정류장과 다른 값은 건드리지 않고, 마지막으로 바뀐 시각(updatedAt)도 그대로
//   · ODsay 검색 결과(외부 DB, 최대 90일): odsay.coarsenGps() — GPS 항목의 좌표 · 키를 같은 칸으로(경로 · 보관 기한 그대로)
//   · 몇 번을 돌려도 결과가 같음(이미 칸이면 건너뜀) · 외부 DB를 아직 못 읽었거나 실패하면 1분 뒤 다시(최대 60번)
import { coarseOrigin, isPreciseGps } from '../../shared/geoPrivacy.js';

/** 이 사용자 기록의 GPS 출발지를 칸으로(바꾼 개수) — 그 밖의 값은 그대로 */
export function coarseUserCoords(u) {
  const t = u?.transit;
  if (!t || typeof t !== 'object') return 0;
  let n = 0;
  if (isPreciseGps(t.origin)) { t.origin = coarseOrigin(t.origin); n++; }
  if (t.retry && typeof t.retry === 'object' && isPreciseGps(t.retry.origin)) { t.retry = { ...t.retry, origin: coarseOrigin(t.retry.origin) }; n++; }
  return n;
}

/** /api/health용: 저장된 GPS 출발지 수 · 그중 아직 칸보다 정밀한 수(옮긴 뒤에는 0) — 좌표 값은 싣지 않음 */
export function userCoordStats(store) {
  let gps = 0, precise = 0;
  for (const [, u] of store.users()) {
    for (const o of [u?.transit?.origin, u?.transit?.retry?.origin]) {
      if (o?.kind !== 'gps') continue;
      gps++;
      if (isPreciseGps(o)) precise++;
    }
  }
  return { gps, precise };
}

/**
 * @param {{ store, odsay?, clock?, log?, retryMs?, maxTries? }} o  odsay = createOdsayService()(없으면 사용자 기록만)
 */
export function createCoordMigration({ store, odsay = null, clock = () => Date.now(), log = console, retryMs = 60_000, maxTries = 60 }) {
  const st = { done: false, tries: 0, ranAt: null, users: null, odsayCache: null, lastError: null, timer: null, stopped: false };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

  /** 한 번 돌리기: { waiting } | { users, odsayCache } */
  async function run() {
    st.tries++;
    if (!store.info?.().loaded) return { waiting: true }; // 외부 DB를 다 읽기 전에는 옮기지 않음(읽은 값으로 덮일 수 있음)
    let users = 0, origins = 0;
    for (const [id, u] of store.users()) {
      if (!isPreciseGps(u?.transit?.origin) && !isPreciseGps(u?.transit?.retry?.origin)) continue;
      store.update(id, (x) => { origins += coarseUserCoords(x); }, { touch: false });
      users++;
    }
    st.users = { users: (st.users?.users || 0) + users, origins: (st.users?.origins || 0) + origins };
    try {
      if (odsay?.coarsenGps) st.odsayCache = await odsay.coarsenGps();
      st.lastError = null; st.done = true;
    } catch (e) {
      st.lastError = { message: String(e?.message || e).slice(0, 200), at: clock() };
      log.warn?.(`[coords] ODsay 검색 결과 옮기기 실패(${st.lastError.message}) — ${retryMs / 1000}초 뒤 다시`);
    }
    st.ranAt = clock();
    if (users || st.odsayCache?.moved || st.odsayCache?.merged) log.info?.(`[coords] GPS 출발지를 약 100m 칸으로 옮겼어요: 사용자 ${users}명(${origins}곳) · 검색 결과 ${st.odsayCache?.moved || 0}개(겹쳐서 지운 것 ${st.odsayCache?.merged || 0}개)`);
    return { users, origins, odsayCache: st.odsayCache };
  }

  function schedule(tick) {
    if (st.stopped || st.done || st.tries >= maxTries) return;
    st.timer = setTimeout(tick, retryMs);
    st.timer.unref?.();
  }
  /** 저장소 준비(store.ready) 뒤 시작 — 못 했으면 1분마다 다시 */
  function start() {
    const tick = async () => {
      st.timer = null;
      if (st.stopped) return;
      try { await run(); } catch (e) { st.lastError = { message: String(e?.message || e).slice(0, 200), at: clock() }; }
      schedule(tick);
    };
    Promise.resolve(store.ready).then(tick, tick);
  }

  return {
    run,
    start,
    stop() { st.stopped = true; clearTimeout(st.timer); st.timer = null; },
    health() {
      return { done: st.done, tries: st.tries, ranAt: iso(st.ranAt), users: st.users, odsayCache: st.odsayCache, lastError: st.lastError && { ...st.lastError, at: iso(st.lastError.at) } };
    },
  };
}
