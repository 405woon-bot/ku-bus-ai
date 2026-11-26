// v2.6.0 환승 구간(첫 탑승이 아닌 탈 것) 실시간 — 화면 요청에서 기기가 '다음 탈 환승 구간'을 알려 줄 때만(서버 출발 알림 계산에는 없음)
//   · 부를지 · 기준 시각 · ±15분 창은 shared midCheck(구간 종류와 상관없음): '출발했어요!' 기록 · 켠 종류의 환승 구간 · 실시간 허용 목록 ·
//     예정 탑승 ±15분(기기 기준을 서버 표준값 −15 ~ +30분 안에서만) — 한 번에 한 곳
//   · 받아 오기 · 하루 몫(midBudget.js) · 개수는 종류별 MID_FETCH. 개수는 알려 준 구간의 종류 쪽에 셈(그 종류를 받지 않으면 세지 않음)
//   지금은 지하철만. v2.7.0 중간 환승 버스(서울 · 경기)는 shared MID_LIVE_KINDS에 'bus'를 더하고, 여기 MID_FETCH에 bus를 더하면 됨
//     (예: deps.provider 서울시 버스 · deps.gyeonggi 경기도 버스 — 각 서비스에 createMidBudget으로 별도 상한 · 결과는 { …base, source, buses })
import { MID_LIVE_KINDS, midCheck, planTransit } from '../../../shared/transitPlan.js';
import { trainsForLeg } from '../../../shared/subwayArrivals.js';

const SKIP_NOTE = { 'not-departed': 'notDeparted', 'not-transfer': 'notTransfer', 'not-yet': 'notYet', passed: 'passed' };

/** 지하철: 서울시 실시간 지하철(seoulSubway — 환승 지하철 몫 · 1분 다시 쓰기) → 내 방향 열차 최대 4개 */
async function fetchSubway({ M, base, note, deps, nowMs }) {
  const subway = deps.subway;
  if (!subway?.keyConfigured) return { ...base, source: 'off', reason: 'no-service', trains: [] };
  if (!subway.midCap) return { ...base, source: 'off', reason: 'mid-off', trains: [] }; // SEOUL_SUBWAY_MID_DAILY_CAP=0
  let r;
  try { r = await subway.arrivals(M.from.name, { mid: true }); } catch (e) { note('failed'); return { ...base, source: 'error', reason: e?.message || 'api', trains: [] }; }
  // 상한(하루 900 · 환승 지하철 몫)에 닿은 것은 실패로 세지 않음(health의 callsToday · mid.capReached로 보임)
  if (r.source !== 'seoul') { if (r.source !== 'cap') note(r.source === 'nodata' ? 'empty' : 'failed'); return { ...base, source: r.source, reason: r.reason || null, trains: [] }; }
  const age = r.fetchedAt ? Math.max(0, (nowMs - Date.parse(r.fetchedAt)) / 1000) : 0;
  const drops = {};
  const trains = trainsForLeg(r.rows, M, drops).map((t) => ({ etaSec: Math.round(t.etaSec - age), approx: t.approx, dest: t.dest, last: t.last })).filter((t) => t.etaSec > -30).slice(0, 4);
  subway.countFiltered?.(drops);
  if (!trains.length) { note('empty'); return { ...base, source: 'nodata', reason: 'no-train', station: r.station || base.station, trains: [] }; }
  note('used');
  return { ...base, source: 'seoul', station: r.station || base.station, trains };
}

/**
 * 종류별: 개수를 셀 서비스(noteMid) · 결과 바탕(역 · 노선) · 받아 오기
 * v2.7.0 예: bus: { service: (deps) => …(서울 · 경기 판단에 따라), base: (M) => ({ stop: M.from.name, no: M.no }), empty: () => ({ buses: [] }), fetch: fetchBus }
 */
export const MID_FETCH = Object.freeze({
  subway: { service: (deps) => deps.subway, base: (M) => ({ station: M?.from?.name || null, line: M?.line || null }), empty: () => ({ trains: [] }), fetch: fetchSubway },
});
/** 지금 켠 종류: shared MID_LIVE_KINDS 중 받아 오기가 있는 것(둘 다 있어야 켜짐) */
export const midKinds = () => MID_LIVE_KINDS.filter((k) => MID_FETCH[k]);

/**
 * @param {{ route, midHint: { i, at }, cls, nowMin, nowMs, walkTable, marginMin, personalOffsetMin, departedMin, deps: { subway } }} p
 * @returns {Promise<null | { i, kind, source:'seoul'|'skip'|'nodata'|'off'|'cap'|'quota'|'error', reason, …base, trains }>}
 *   null = 기기가 알려 준 구간이 없음(아무것도 붙이지 않음)
 */
export async function midLive({ route, midHint, cls, nowMin, nowMs, walkTable, marginMin, personalOffsetMin, departedMin, deps = {} }) {
  // 서버 표준값: '출발했어요!' 기록 시각에 나갔다고 보고 실시간 없이(이미 탄 구간 고정값은 기기에만 있어 쓰지 않음)
  const std = cls && departedMin != null ? planTransit({ route, cls, nowMin, walkTable, marginMin, personalOffsetMin, departedMin }) : null;
  const chk = midCheck(route, std, midHint, nowMin, { offLines: deps.subway?.offLines, kinds: midKinds() });
  if (chk.reason === 'no-hint') return null;
  const M = Number.isInteger(chk.i) ? route.legs?.[chk.i] ?? null : null;
  const F = M ? MID_FETCH[M.kind] || null : null;
  const svc = F ? F.service(deps) : null;
  const note = (k) => svc?.noteMid?.(k);
  const base = { i: chk.i ?? null, kind: M?.kind || null, ...(F ? F.base(M) : {}) };
  const none = F ? F.empty() : { trains: [] };
  if (!chk.ok) {
    if (chk.reason === 'line' || chk.reason === 'off') { note(chk.reason); return { ...base, source: 'nodata', reason: chk.reason, ...none }; }
    note(SKIP_NOTE[chk.reason]);
    return { ...base, source: 'skip', reason: chk.reason, ...none };
  }
  if (chk.clamped) note('clamped');
  return F.fetch({ M, base, note, deps, nowMs });
}
