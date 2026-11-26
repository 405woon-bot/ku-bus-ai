// v2.6.0 환승 구간(첫 탑승이 아닌 탈 것) 실시간의 '하루 몫 + 개수' — 받아 오는 서비스마다 하나씩(지금은 실시간 지하철 seoulSubway).
//   v2.7.0 중간 환승 버스(서울 · 경기)도 각 서비스에 하나씩 만들어 별도 상한으로 쓰면 됨(외부 DB 키 · 환경 변수 이름만 다르게).
//   · 새로 부를 때만 셈(역 · 정류장 하나 = 1회) · 외부 DB 날짜별 카운터(서버를 다시 켜도 그날 값 이어감) · 한국 시각 자정에 새로
//   · 개수만 셈(역 · 정류장 · 노선 이름 · 사용자 번호 없음) — /api/health에 그대로
//   · 몫이 0이면 꺼짐(비상 스위치): over()가 늘 참이라 부르지 않음

export const MID_DEFAULT_CAP = 300;
export const MID_REUSE_SEC = 60; // 같은 역 · 정류장은 1분 안에 받은 값을 다시 씀(받아 오는 서비스의 캐시가 적용)
const MAX_CAP = 1000;

/** 하루 몫 환경 변수 읽기: 비우면 기본값, '0' · 음수 · 숫자가 아닌 값이면 끔(0), 소수는 내림, 최대 1,000 */
export function parseMidCap(v, dflt = MID_DEFAULT_CAP) {
  const raw = String(v ?? '').trim();
  if (raw === '') return dflt;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_CAP, n) : 0;
}

const SKIPS = ['notDeparted', 'notTransfer', 'notYet', 'passed', 'line', 'off'];
const COUNTS = ['used', 'empty', 'failed', 'clamped'];
const zero = () => ({ used: 0, empty: 0, failed: 0, clamped: 0, skipped: Object.fromEntries(SKIPS.map((k) => [k, 0])) });

/**
 * @param {{ cap: number, kv?: object|null, keyOf: (dateKey: string) => string, today: () => string }} o
 *   cap 하루 몫(0이면 꺼짐) · kv 외부 DB(getNum · incr) · keyOf 날짜별 카운터 키 · today 한국 날짜(YYYY-MM-DD)
 * @returns {{ cap, over(): boolean, take(): void, note(kind: string): void, health(): object }}
 */
export function createMidBudget({ cap, kv = null, keyOf, today }) {
  let date = today(), calls = 0, stats = zero();
  const sync = (d, n) => { if (date === d && Number.isFinite(n)) calls = Math.max(calls, n); };
  if (kv) { const d = date; kv.getNum(keyOf(d)).then((n) => sync(d, n), () => {}); }
  const roll = () => { const d = today(); if (d !== date) { date = d; calls = 0; stats = zero(); } };
  return {
    cap,
    /** 오늘 몫을 다 썼는지(몫이 0이면 늘 참 — 꺼짐) */
    over() { roll(); return calls >= cap; },
    /** 새로 부를 때 한 건(외부 DB는 뒤에서 맞춤 — 기다리지 않음) */
    take() {
      roll();
      calls += 1;
      const d = date;
      if (kv) kv.incr(keyOf(d), 2 * 86400).then((n) => sync(d, n), () => {});
    },
    /** 개수 세기: used · empty · failed · clamped · 부르지 않은 이유(notDeparted · notTransfer · notYet · passed · line · off) */
    note(kind) {
      roll();
      if (SKIPS.includes(kind)) stats.skipped[kind] += 1;
      else if (COUNTS.includes(kind)) stats[kind] += 1;
    },
    health() {
      roll();
      return { cap, callsToday: calls, capReached: cap > 0 && calls >= cap, reuseSec: MID_REUSE_SEC,
        used: stats.used, empty: stats.empty, failed: stats.failed, clamped: stats.clamped, skipped: { ...stats.skipped } };
    },
  };
}
