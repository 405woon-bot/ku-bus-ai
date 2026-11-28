// v2.8.0 쓰지 않는 기록 쉬기(승인한 설계안 그대로):
//   앱 화면을 SCHEDULER_SLEEP_DAYS(비우면 7)일 동안 열지 않은 기록은 스케줄러가 실시간 호출 · 출발 알림 계산을 하지 않음.
//   · '앱을 열었다' = 화면 요청(사용자 번호 헤더가 붙은 요청)이 끝난 때 → lastOpenAt. 저장된 사용자만 · 12시간에 한 번
//     (쉬던 기록은 마지막 기록이 12시간보다 오래돼 열자마자 바로 기록 → 다음 1분부터 다시 계산).
//     cron 깨우기 · 서비스 워커 · 알림 전달 · 알림 수신 확인은 세지 않음(90일 보관의 lastSeen과 따로 셈)
//   · 시작점(since): 이 기능이 처음 켜진 시각을 외부 DB 키 하나(kubusai:sleep:since)에 한 번만 저장(SET NX) —
//     그 전부터 있던 기록은 시작점부터 셈 → 배포 뒤 첫 7일은 아무 기록도 쉬지 않음. 기존 사용자 기록은 다시 쓰지 않음.
//     외부 DB가 없거나 못 읽으면 이 서버가 켜진 시각(더 늦음 = 덜 쉼)
//   · 쉬기 안내 알림: 쉬는 기록에 알림 구독 · 출발 알림 켬 · 시간표가 있으면 낮(09:00 ~ 21:00)에 한 번.
//     다시 열 때까지 한 번만 — 알림 서버가 하나도 받지 않았으면(구독이 막힌 경우 등) 하루 뒤 한 번 더. 교통 API는 부르지 않음(Web Push만)
import { seoulParts } from '../../shared/time.js';

export const OPEN_STEP_MS = 12 * 3600_000;
export const SLEEP_SINCE_KEY = 'kubusai:sleep:since';
export const NOTICE_HOURS = Object.freeze([9, 21]); // 쉬기 안내 알림을 보내는 시간(서울, 시작 ~ 끝 전)
const DAY_MS = 86_400_000;

/** SCHEDULER_SLEEP_DAYS: 비우면 7 · 0이면 쉬기 끔 · 3 ~ 90(숫자가 아니면 7) */
export function sleepDays(env = process.env) {
  const raw = String(env.SCHEDULER_SLEEP_DAYS ?? '').trim();
  if (raw === '') return 7;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 7;
  if (n <= 0) return 0;
  return Math.max(3, Math.min(90, Math.round(n)));
}

/** 쉬기 안내 알림 문구(승인한 미리보기 그대로) */
export const sleepNoticeText = (days) => ({
  title: '출발 알림을 잠시 쉬어요',
  body: `${days}일 동안 앱을 열지 않아 서버가 출발 알림 계산을 멈췄어요. 앱을 한 번 열면 바로 다시 알려 드려요.`,
});

/** 외부 DB에 저장된(사용자가 무언가를 저장한) 기록만 — 화면이 읽기만 해서 메모리에 생긴 빈 기록은 세지 않음(90일 보관과 같은 기준) */
const saved = (u) => Boolean(u) && Number(u.updatedAt) > 0;

/**
 * @param {{ store, env?, kv?: { setnx(k, v): Promise<boolean>, get(k): Promise<string|null> } | null, clock?: () => number, log? }} o
 */
export function createSleep({ store, env = process.env, kv = null, clock = () => Date.now(), log = console }) {
  const days = sleepDays(env);
  const st = { since: clock(), sinceFrom: 'start', notices: 0, lastNoticeAt: null };
  const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

  // 시작점: 외부 DB에 없으면 지금을 한 번만 저장, 있으면 그 값(이상한 값이면 무시하고 이 서버가 켜진 시각)
  const ready = (async () => {
    if (!kv?.setnx || !kv?.get) return;
    try {
      const t = clock();
      await kv.setnx(SLEEP_SINCE_KEY, String(t));
      const v = Number(await kv.get(SLEEP_SINCE_KEY));
      if (Number.isFinite(v) && v > 0 && v <= t + DAY_MS) { st.since = v; st.sinceFrom = kv.kind || 'kv'; }
    } catch (e) {
      log.warn?.(`[sleep] 쉬기 시작점을 외부 DB에서 읽지 못했어요(${String(e?.message || e).slice(0, 120)}) — 이 서버가 켜진 시각부터 셈`);
    }
  })();

  /** 화면 요청 → 마지막 앱 열기. 저장된 사용자만 · 12시간에 한 번(쉬던 기록은 바로) · 마지막으로 바뀐 시각(updatedAt)은 그대로 */
  function markOpen(id, at = clock()) {
    if (!id) return false;
    const u = store.peek(id);
    if (!saved(u)) return false;
    const last = Number(u.lastOpenAt);
    if (Number.isFinite(last) && at - last >= 0 && at - last < OPEN_STEP_MS) return false;
    store.update(id, (x) => { x.lastOpenAt = at; }, { touch: false });
    return true;
  }

  /** 쉬기 판단에 쓰는 마지막 앱 열기: 기록이 없으면 시작점 · 미래 값(시계가 이상한 기록)은 지금으로 */
  function lastOpenOf(u, t = clock()) {
    const v = Number(u?.lastOpenAt);
    const last = Number.isFinite(v) && v > 0 ? Math.min(v, t) : 0;
    return Math.max(last, st.since);
  }

  /** 지금 쉬는 기록인지(SCHEDULER_SLEEP_DAYS=0이면 늘 아님) */
  function asleep(u, t = clock()) {
    return days > 0 && t - lastOpenOf(u, t) > days * DAY_MS;
  }

  /** 쉬기 안내 알림을 보낼 때인지: 쉬는 중 · 알림 구독 · 출발 알림 켬 · 시간표 · 낮 · 이번 쉬기에 아직 안 보냄(못 보냈으면 하루 뒤) */
  function noticeDue(u, t = clock()) {
    if (!asleep(u, t) || !u?.push?.length || u.prefs?.notify === false || !u.classes?.length) return false;
    const m = seoulParts(new Date(t)).minutes;
    if (m < NOTICE_HOURS[0] * 60 || m >= NOTICE_HOURS[1] * 60) return false;
    const n = u.sleepNotice;
    if (!n || !(Number(n.at) >= lastOpenOf(u, t))) return true; // 이번 쉬기에서 처음
    return !(Number(n.sent) > 0) && t - Number(n.at) >= DAY_MS;  // 하나도 못 보냈으면 하루 뒤 한 번 더
  }

  /** 안내 알림을 보낸 뒤 기록(사용자 기록에는 { at, sent } — 마지막으로 바뀐 시각은 그대로) */
  function noted(id, { at = clock(), sent = 0 } = {}) {
    if (store.peek(id) === undefined) return; // 보내는 사이 지워진 사용자(90일 자동 삭제)
    store.update(id, (x) => { x.sleepNotice = { at, sent: Number(sent) || 0 }; }, { touch: false });
    st.notices++; st.lastNoticeAt = at;
  }

  return {
    days,
    ready,
    markOpen,
    lastOpenOf,
    asleep,
    noticeDue,
    noted,
    text: () => sleepNoticeText(days),
    /** /api/health용(개수 · 시각만) */
    health: () => ({ days, on: days > 0, since: iso(st.since), sinceFrom: st.sinceFrom, notices: st.notices, lastNoticeAt: iso(st.lastNoticeAt) }),
  };
}
