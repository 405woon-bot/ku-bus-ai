// v2.2.4 보관 기간: 마지막 사용 후 90일이 지나면 서버의 사용자 기록을 자동으로 지웁니다(데이터 정책, 2026-11-23 확정).
//   · 마지막 사용(lastSeen): ① 이 사용자의 화면이 서버에 요청을 보낸 때(12시간에 한 번만 기록) ② 이 사용자의 휴대폰으로 출발 알림이
//     전달됐을 때(알림 서버가 받음) ③ 휴대폰이 알림을 받았다고 알린 때. 서버가 스스로 하는 일(좌표 옮기기 · cron 깨우기 · 상태 확인)은 세지 않음.
//     공용 'demo'는 세지 않음(예전 화면이 여럿이 같이 쓰던 기록 — 기산점부터 90일 뒤 지워짐)
//   · 기산점: 이 기능이 처음 켜진 때(배포 시점). 그 전부터 있던 사용자는 lastSeen을 그 시각으로 채워 적어도 90일 동안은 지워지지 않음
//   · 안전장치: 외부 DB를 다 읽기 전에는 아무것도 안 함 · lastSeen이 없거나 미래인 기록은 지우지 않음 · 한 번에 저장된 사용자의 절반 넘게
//     (4명 이상) 지워질 상황이면 멈추고 /api/health에 표시(확인 뒤 RETENTION_BULK_OK=1이면 진행) · 한 번에 최대 20명 · 6시간마다 확인
//     · RETENTION_DAYS=0이면 지우기를 끔(기록은 계속) · 30일보다 짧게는 못 정함
//   · 지우는 것: 서버의 그 사용자 기록 전체(시간표 · 정류장 · 출발지 · 설정 · 알림 구독 · 알림/도착 기록). 휴대폰에 남은 값은 그대로라,
//     다시 앱을 열면 새 기록으로 시작(화면이 정류장 · 설정을 다시 올려 줌)
import { SHARED_ID } from '../../shared/userId.js';

export const SEEN_STEP_MS = 12 * 3600_000;
const DAY_MS = 86400_000;

/** RETENTION_DAYS: 비우면 90 · 0이면 끔 · 30~3650 */
export function retentionDays(env = process.env) {
  const raw = String(env.RETENTION_DAYS ?? '').trim();
  if (raw === '') return 90;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 90;
  if (n <= 0) return 0;
  return Math.max(30, Math.min(3650, Math.round(n)));
}

/** 외부 DB에 저장된(사용자가 무언가를 저장한) 기록만 — 화면이 읽기만 해서 메모리에 생긴 빈 기록은 저장되지 않음 */
const saved = (u) => Boolean(u) && Number(u.updatedAt) > 0;

/**
 * @param {{ store, env?, clock?, log?, intervalMs?, maxPerRun? }} o
 */
export function createRetention({ store, env = process.env, clock = () => Date.now(), log = console, intervalMs = 6 * 3600_000, retryMs = 60_000, maxPerRun = 20 }) {
  const days = retentionDays(env);
  const bulkOk = /^(1|true|yes)$/i.test(String(env.RETENTION_BULK_OK ?? '').trim());
  const st = { runs: 0, lastRunAt: null, backfilled: 0, deletedTotal: 0, lastDeleted: null, held: null, lastError: null, timer: null, retry: null, stopped: false };
  const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

  /** 사용 기록(화면 요청). 저장된 사용자만 · 12시간에 한 번만 저장(외부 DB 쓰기를 아끼려고) · 마지막으로 바뀐 시각은 그대로 */
  function touch(id, at = clock()) {
    if (!id || id === SHARED_ID) return false;
    const u = store.peek(id);
    if (!saved(u)) return false;
    const last = Number(u.lastSeen);
    if (Number.isFinite(last) && at - last >= 0 && at - last < SEEN_STEP_MS) return false;
    store.update(id, (x) => { x.lastSeen = at; }, { touch: false });
    return true;
  }

  /** 기산점: lastSeen이 없는 저장된 사용자는 지금(처음 켜진 때)을 마지막 사용으로 */
  function backfill(t) {
    let n = 0;
    for (const [id, u] of store.users()) {
      if (!saved(u) || (typeof u.lastSeen === 'number' && Number.isFinite(u.lastSeen))) continue;
      store.update(id, (x) => { x.lastSeen = t; }, { touch: false });
      n++;
    }
    return n;
  }

  /** 지울 대상: 저장된 사용자 중 lastSeen이 기간보다 오래된 것(오래된 순) */
  function scan(t) {
    const users = [], due = [];
    let future = 0, unknown = 0, active7 = 0, active30 = 0, oldest = null;
    for (const [id, u] of store.users()) {
      if (!saved(u)) continue;
      users.push(id);
      const last = typeof u.lastSeen === 'number' ? u.lastSeen : NaN;
      if (!Number.isFinite(last)) { unknown++; continue; }
      if (last > t + DAY_MS) { future++; continue; }            // 시계가 이상한 기록은 건드리지 않음
      if (t - last <= 7 * DAY_MS) active7++;
      if (t - last <= 30 * DAY_MS) active30++;
      if (oldest === null || last < oldest) oldest = last;
      if (days > 0 && t - last > days * DAY_MS) due.push([id, last]);
    }
    due.sort((a, b) => a[1] - b[1]);
    return { users, due, future, unknown, active7, active30, oldest };
  }

  /** 한 번 확인하기 */
  async function run() {
    st.runs++;
    if (!store.info?.().loaded) return { waiting: true };
    const t = clock();
    const backfilled = backfill(t);
    st.backfilled += backfilled;
    st.lastRunAt = t;
    if (!days) return { off: true, backfilled, deleted: 0 };
    const s = scan(t);
    if (s.due.length >= 4 && s.due.length * 2 > s.users.length && !bulkOk) {
      st.held = { reason: 'bulk', due: s.due.length, users: s.users.length, at: t };
      log.warn?.(`[retention] 한 번에 저장된 사용자 ${s.users.length}명 중 ${s.due.length}명이 지워질 상황이라 멈췄어요 — 확인 뒤 RETENTION_BULK_OK=1`);
      return { held: true, backfilled, deleted: 0 };
    }
    st.held = null;
    let deleted = 0;
    for (const [id] of s.due.slice(0, maxPerRun)) if (store.remove(id)) deleted++;
    if (deleted) {
      st.deletedTotal += deleted;
      st.lastDeleted = { count: deleted, at: t };
      log.info?.(`[retention] ${days}일 넘게 쓰지 않은 사용자 ${deleted}명의 기록을 지웠어요`);
    }
    return { backfilled, deleted };
  }

  function start() {
    const tick = async () => {
      if (st.stopped) return;
      let r = null;
      try { r = await run(); st.lastError = null; } catch (e) { st.lastError = { message: String(e?.message || e).slice(0, 200), at: clock() }; }
      // 외부 DB를 아직 못 읽었으면 1분 뒤 다시(기산점 채우기가 6시간씩 밀리지 않게)
      if (r?.waiting && !st.stopped && !st.retry) { st.retry = setTimeout(() => { st.retry = null; tick(); }, retryMs); st.retry.unref?.(); }
    };
    Promise.resolve(store.ready).then(tick, tick);
    st.timer = setInterval(tick, intervalMs);
    st.timer.unref?.();
  }

  return {
    days,
    touch,
    run,
    start,
    stop() { st.stopped = true; clearInterval(st.timer); clearTimeout(st.retry); st.timer = null; st.retry = null; },
    /** /api/health용: 개수 · 시각만(사용자 ID · 기록 내용은 싣지 않음) */
    health() {
      const t = clock(), s = scan(t);
      return {
        days, on: days > 0, users: s.users.length, active7: s.active7, active30: s.active30, noLastSeen: s.unknown, future: s.future,
        dueNow: days > 0 ? s.due.length : 0, nextDueAt: days > 0 && s.oldest !== null ? iso(s.oldest + days * DAY_MS) : null,
        held: st.held && { ...st.held, at: iso(st.held.at) }, deletedTotal: st.deletedTotal, lastDeleted: st.lastDeleted && { ...st.lastDeleted, at: iso(st.lastDeleted.at) },
        backfilled: st.backfilled, runs: st.runs, lastRunAt: iso(st.lastRunAt), lastError: st.lastError && { ...st.lastError, at: iso(st.lastError.at) },
      };
    },
  };
}
