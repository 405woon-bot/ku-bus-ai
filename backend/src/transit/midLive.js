// v2.6.0 환승 구간(첫 탑승이 아닌 탈 것) 실시간 — 화면 요청에서 기기가 '다음 탈 환승 구간'을 알려 줄 때만(서버 출발 알림 계산에는 없음)
//   · 부를지 · 기준 시각 · ±15분 창은 shared midCheck(구간 종류와 상관없음): '출발했어요!' 기록 · 켠 종류의 환승 구간 · 실시간 허용 목록 ·
//     예정 탑승 ±15분(기기 기준을 서버 표준값 −15 ~ +30분 안에서만) — 한 번에 한 곳
//   · 받아 오기 · 하루 몫(midBudget.js) · 개수는 종류별 MID_FETCH. 개수는 알려 준 구간의 종류 쪽에 셈(그 종류를 받지 않으면 세지 않음)
//   v2.6.0 지하철(서울시 실시간 지하철) · v2.7.0 버스(정류장 판단은 v2.5.0 그대로 — 경기도 정류장이면 경기도 도착 정보, 서울시 정류장이면 서울시 정류장 도착):
//     판단 결과 '쓸 수 있음' → 경기도(gyeonggiBus.midArrivalsFor · 몫 150) / 서울 · 인천 · 못 찾음 · 지역 없음 · 노선 없음 · 경기도 키 없음 → 서울시
//     (index.js stopArrivalsMid · 몫 100 · 보호선 800 — 정류장 번호 5자리 + 버스 번호, 같은 번호가 두 줄이면 안 씀, 응답의 정류장 이름이 다르면 안 씀) /
//     애매함 · 두 방향 · 판단 실패 · 입력 부족 → 부르지 않음 / 아직 판단 안 함 → 이번엔 판단만(다음 갱신부터)
import { MID_LIVE_KINDS, midCheck, planTransit } from '../../../shared/transitPlan.js';
import { trainsForLeg } from '../../../shared/subwayArrivals.js';
import { busNo, sameStopName } from './gyeonggiBus.js';

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

/* ── v2.7.0 버스 ── */
const UNSURE_STOP = new Set(['ambiguous', 'twoWay', 'failed', 'badInput']); // 확실하지 않은 판단 → 부르지 않음(첫 버스와 달리 서울시로도 묻지 않음)
/**
 * 어디에 물을지(v2.5.0 정류장 판단 그대로 — 정류장마다 30일 보관):
 * @returns {{ region: 'gyeonggi', j } | { region: 'seoul' } | { pending: true } | { unsure: true }}
 */
function busRegion(M, deps) {
  const gg = deps.gyeonggi;
  if (!gg?.keyConfigured) return { region: 'seoul' };
  if (!gg.canJudge?.(M)) return { unsure: true };
  const j = gg.stopFor(M); // 보관한 결과가 없으면 뒤에서 판단을 시작하고 null
  if (!j) return { pending: true };
  if (j.status === 'usable') return { region: 'gyeonggi', j };
  if (UNSURE_STOP.has(j.status)) return { unsure: true };
  return { region: 'seoul' }; // seoul · incheon · notFound · noRegion · noRoute
}
/** 개수를 셀 곳(창 밖 요청 등 받아 오기 전): 보관한 판단이 경기도 정류장이면 경기도 쪽, 아니면 서울시 쪽(새로 판단하지 않음) */
const busSink = (deps, M) => (deps.gyeonggi?.keyConfigured && deps.gyeonggi.judgedFor?.(M)?.status === 'usable' ? deps.gyeonggi : deps.provider);

async function fetchBus({ M, base, deps, nowMs }) {
  const R = busRegion(M, deps);
  const gnote = (k) => deps.gyeonggi?.noteMid?.(k), snote = (k) => deps.provider?.noteMid?.(k);
  if (R.pending) { gnote('judging'); return { ...base, source: 'skip', reason: 'judging', buses: [] }; }
  if (R.unsure) { gnote('stop'); return { ...base, source: 'nodata', reason: 'stop', buses: [] }; }
  if (R.region === 'gyeonggi') {
    const gg = deps.gyeonggi;
    if (!gg.midCap) return { ...base, region: 'gyeonggi', source: 'off', reason: 'mid-off', buses: [] }; // GYEONGGI_BUS_MID_DAILY_CAP=0
    let r;
    try { r = await gg.midArrivalsFor(R.j, M); } catch (e) { gnote('failed'); return { ...base, region: 'gyeonggi', source: 'error', reason: e?.message || 'api', buses: [] }; }
    if (r.source !== 'gyeonggi') { if (r.source !== 'cap') gnote('failed'); return { ...base, region: 'gyeonggi', source: r.source, reason: r.reason || null, buses: [] }; }
    if (!r.buses.length) { gnote('empty'); return { ...base, region: 'gyeonggi', source: 'nodata', reason: 'no-bus', buses: [] }; }
    gnote('used');
    return { ...base, region: 'gyeonggi', source: 'gyeonggi', buses: r.buses };
  }
  // 서울시 정류장: 정류장 번호(5자리) + 버스 번호(첫 버스와 같은 규칙)에 두 가지를 더함 — 같은 번호가 두 줄(두 방향)이면 안 씀 · 응답의 정류장 이름이 다르면 안 씀
  const P = deps.provider, ars = String(M.from?.arsId || '');
  if (!/^\d{5}$/.test(ars)) { snote('noArs'); return { ...base, region: 'seoul', source: 'nodata', reason: 'no-ars', buses: [] }; }
  if (!P?.stopArrivalsMid) return { ...base, region: 'seoul', source: 'off', reason: 'no-service', buses: [] };
  if (!P.midCap) return { ...base, region: 'seoul', source: 'off', reason: 'mid-off', buses: [] }; // SEOUL_BUS_MID_DAILY_CAP=0
  let r;
  try { r = await P.stopArrivalsMid(ars); } catch (e) { snote('failed'); return { ...base, region: 'seoul', source: 'error', reason: e?.message || 'api', buses: [] }; }
  // 상한(하루 몫 · 보호선 · 한도 초과 쉼)은 실패로 세지 않음(health live.mid로 보임)
  if (r.source !== 'seoul') { if (r.source !== 'cap' && r.source !== 'off') snote('failed'); return { ...base, region: 'seoul', source: r.source, reason: r.reason || null, buses: [] }; }
  const want = new Set((M.buses?.length ? M.buses : [M.no]).map(busNo).filter(Boolean));
  const rows = (r.arrivals || []).filter((a) => want.has(busNo(a.no)));
  const nos = rows.map((a) => busNo(a.no));
  if (new Set(nos).size !== nos.length) { snote('twoWay'); return { ...base, region: 'seoul', source: 'nodata', reason: 'two-way', buses: [] }; }
  const names = [...new Set((r.arrivals || []).map((a) => a.stopName).filter(Boolean))];
  if (names.length && !names.some((n) => sameStopName(n, M.from?.name))) { snote('mismatch'); return { ...base, region: 'seoul', source: 'nodata', reason: 'mismatch', buses: [] }; }
  const age = Math.max(0, Number(r.ageSec) || 0);
  const buses = rows.filter((a) => !a.ended).map((a) => ({
    no: a.no, termMin: a.termMin, msgs: a.msgs,
    etasSec: (a.etasSec || []).map((x) => Math.round(x - age)).filter((x) => x > -30).map((x) => Math.max(0, x)),
  })).filter((b) => b.etasSec.length);
  if (!buses.length) { snote('empty'); return { ...base, region: 'seoul', source: 'nodata', reason: 'no-bus', buses: [] }; }
  snote('used');
  return { ...base, region: 'seoul', source: 'seoul', arsId: ars, buses };
}

/**
 * 종류별: 개수를 셀 서비스(noteMid — 받아 오기 전 개수) · 결과 바탕 · 빈 값 · 받아 오기
 */
export const MID_FETCH = Object.freeze({
  subway: { service: (deps) => deps.subway, base: (M) => ({ station: M?.from?.name || null, line: M?.line || null }), empty: () => ({ trains: [] }), fetch: fetchSubway },
  bus: { service: (deps, M) => busSink(deps, M), base: (M) => ({ stop: M?.from?.name || null, no: M?.no || null }), empty: () => ({ buses: [] }), fetch: fetchBus },
});
/** 지금 켠 종류: shared MID_LIVE_KINDS 중 받아 오기가 있는 것(둘 다 있어야 켜짐) */
export const midKinds = () => MID_LIVE_KINDS.filter((k) => MID_FETCH[k]);

/**
 * @param {{ route, midHint: { i, at }, cls, nowMin, nowMs, walkTable, marginMin, personalOffsetMin, departedMin, deps: { subway, provider, gyeonggi } }} p
 * @returns {Promise<null | { i, kind, source:'seoul'|'gyeonggi'|'skip'|'nodata'|'off'|'cap'|'quota'|'error', reason, …base, trains | buses }>}
 *   null = 기기가 알려 준 구간이 없음(아무것도 붙이지 않음)
 */
export async function midLive({ route, midHint, cls, nowMin, nowMs, walkTable, marginMin, personalOffsetMin, departedMin, deps = {} }) {
  // 서버 표준값: '출발했어요!' 기록 시각에 나갔다고 보고 실시간 없이(이미 탄 구간 고정값은 기기에만 있어 쓰지 않음)
  const std = cls && departedMin != null ? planTransit({ route, cls, nowMin, walkTable, marginMin, personalOffsetMin, departedMin }) : null;
  const chk = midCheck(route, std, midHint, nowMin, { offLines: deps.subway?.offLines, kinds: midKinds() });
  if (chk.reason === 'no-hint') return null;
  const M = Number.isInteger(chk.i) ? route.legs?.[chk.i] ?? null : null;
  const F = M ? MID_FETCH[M.kind] || null : null;
  const svc = F ? F.service(deps, M) : null;
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
