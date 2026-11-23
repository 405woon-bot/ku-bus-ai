// 저장한 환승 경로의 실시간 재료 — 서버 출발 알림(planner)과 화면(/api/transit/live)이 같이 씀
//   첫 탑승: 지하철 = 서울시 실시간 지하철(표준 계산 출발 30분 전 ~ 출발 20분 뒤에만 — 하루 1,000건 한도 아끼기)
//            버스 = 서울시 버스 정류장 도착 예정(경로의 버스 번호만)
//   마지막 버스(국민대행): 서울시 버스(기존 직행 계산과 같은 국민대행 노선 · 실시간 차내 시간 · 하차 문)
//   예시(모의) 데이터는 섞지 않음 → 받지 못하면 source로 알리고 계산은 ODsay 표준 대기 시간으로(화면에 '예상')
//   v2.1(화면 요청에만, extras): 경로 주변 돌발정보 · 국민대 날씨 · 마지막 국민대행 버스의 '왜 늦나요?'(직행과 같은 기준 · 같은 코드)
//     돌발정보 경로 = 마지막 버스(서울시 경유 정류장) + 그 밖의 버스 구간(ODsay 경유 정류장 좌표가 있으면). 지하철 구간은 도로가 아니라 뺌
import { legEnds, planTransit, wantsLive } from '../../../shared/transitPlan.js';
import { trainsForLeg } from '../../../shared/subwayArrivals.js';
import { seoulParts } from '../../../shared/time.js';
import { delayMinutes } from '../../../shared/explain.js';

const slimTrip = (t) => ({
  busRouteId: t.busRouteId, no: t.no, type: t.type, etasSec: t.etasSec, termMin: t.termMin, msgs: t.msgs, ended: t.ended,
  inVehicleMin: t.inVehicleMin, gate: t.gate, congestion: t.congestion, boardName: t.boardName, alightName: t.alightName,
});
// v2.1 화면의 '왜 늦나요?'에 필요한 값까지(지연 분 · 평균 시속 · 설명). 경로 좌표(path)는 서버 안에서만 쓰고 보내지 않음
const slimWhyTrip = (t) => ({
  ...slimTrip(t), kmh: Number.isFinite(t.kmh) ? Math.round(t.kmh * 10) / 10 : null, cause: t.cause ?? null,
  delayMin: t.delayMin ?? delayMinutes(t), ...(t.explain ? { explain: t.explain } : {}),
});

/**
 * @param {{ route, provider, subway, nowDate?, cls?, walkTable?, marginMin?, personalOffsetMin?, force?, extras? }} p
 *   extras = { incidents, weather, explainer } — 화면 요청(/api/transit/live)에서만. 서버 알림 계산에는 넘기지 않음(AI 호출 아끼기)
 * @returns {Promise<{ fetchedAt, first: object|null, final: object|null, incidents?, weather? }>}  도착 예정(초)은 fetchedAt 기준
 */
export async function transitLive({ route, provider, subway, nowDate = new Date(), cls = null, walkTable = {}, marginMin, personalOffsetMin = 0, force = false, extras = null, departedMin = null }) {
  const legs = route?.legs || [];
  const { first, last } = legEnds(route);
  const nowMs = nowDate.getTime(), nowMin = seoulParts(nowDate).minutes;
  const out = { fetchedAt: nowDate.toISOString(), first: null, final: null };
  const jobs = [];
  const L = legs[last], F = legs[first];
  let finalFull = []; // 서울시 실시간 국민대행 trips(경로 좌표 · 속도 포함) — '왜 늦나요?' 재료
  if (L?.kind === 'bus') {
    if (!L.from?.arsId) out.final = { i: last, source: 'unavailable', reason: 'no-ars', trips: [] };
    else {
      jobs.push(provider.stopTrips(L.from.arsId, nowDate).then((r) => {
        if (r.source === 'seoul') finalFull = r.trips || [];
        out.final = r.source === 'seoul'
          ? { i: last, source: 'seoul', arsId: L.from.arsId, stale: Boolean(r.stale), ageSec: r.ageSec || 0, trips: (r.trips || []).map(slimTrip) }
          : { i: last, source: 'unavailable', reason: r.reason || 'mock', arsId: L.from.arsId, trips: [] };
      }, (e) => { out.final = { i: last, source: 'error', reason: e?.kind || 'api', trips: [] }; }));
    }
  }
  if (F?.kind === 'bus' && first !== last) {
    if (!F.from?.arsId) out.first = { i: first, kind: 'bus', source: 'unavailable', reason: 'no-ars', buses: [] };
    else {
      jobs.push(provider.stopArrivals(F.from.arsId).then((r) => {
        const want = new Set(F.buses?.length ? F.buses : [F.no]);
        out.first = { i: first, kind: 'bus', source: 'seoul', arsId: F.from.arsId,
          buses: r.arrivals.filter((a) => want.has(a.no)).map((a) => ({ no: a.no, etasSec: a.etasSec, termMin: a.termMin, msgs: a.msgs })) };
      }, (e) => { out.first = { i: first, kind: 'bus', source: e?.kind === 'no-key' ? 'off' : 'error', reason: e?.kind || 'api', buses: [] }; }));
    }
  }
  if (F?.kind === 'subway') {
    // v2.2 '출발했어요!'를 눌렀으면 그 출발 시각 기준(출발 30분 전 ~ 20분 뒤에만 지하철 실시간)
    const std = cls ? planTransit({ route, cls, nowMin, walkTable, marginMin, personalOffsetMin, departedMin }) : null;
    if (!force && !wantsLive(std, nowMin)) out.first = { i: first, kind: 'subway', source: 'skip', reason: 'not-yet', station: F.from.name, trains: [] };
    else if (!subway) out.first = { i: first, kind: 'subway', source: 'off', reason: 'no-service', station: F.from.name, trains: [] };
    else {
      jobs.push(subway.arrivals(F.from.name).then((r) => {
        const age = r.fetchedAt ? Math.max(0, (nowMs - Date.parse(r.fetchedAt)) / 1000) : 0;
        const trains = r.source === 'seoul'
          ? trainsForLeg(r.rows, F).map((t) => ({ etaSec: Math.round(t.etaSec - age), approx: t.approx, dest: t.dest, last: t.last })).filter((t) => t.etaSec > -30).slice(0, 4)
          : [];
        const none = r.source === 'seoul' && !trains.length;
        out.first = { i: first, kind: 'subway', source: none ? 'nodata' : r.source, reason: none ? 'no-train' : r.reason || null, station: r.station || F.from.name, trains };
      }, (e) => { out.first = { i: first, kind: 'subway', source: 'error', reason: e?.message || 'api', trains: [] }; }));
    }
  }
  await Promise.all(jobs);
  if (extras) await addWhy(out, { legs, last, finalFull, nowDate, ...extras });
  return out;
}

/** v2.1 경로 주변 돌발정보 · 날씨 · 마지막 국민대행 버스의 '왜 늦나요?'(실패해도 경로 계산은 그대로 — 이 값들만 빠짐) */
async function addWhy(out, { legs, last, finalFull, nowDate, incidents = null, weather = null, explainer = null }) {
  // 돌발정보를 맞춰 볼 버스 경로: 마지막 국민대행 버스(서울시 경유 정류장) + 그 밖의 버스 구간(ODsay 경유 정류장 좌표)
  const pathTrips = [
    ...finalFull.filter((t) => t.path?.length).map((t) => ({ no: t.no, path: t.path })),
    ...legs.map((l, i) => ({ l, i })).filter(({ l, i }) => l.kind === 'bus' && l.path?.length >= 2 && !(i === last && finalFull.length)).map(({ l }) => ({ no: l.no, path: l.path })),
  ];
  const [inc, wx] = await Promise.all([
    incidents ? incidents.forTrips(pathTrips, nowDate).catch((e) => ({ source: 'error', reason: 'api', message: e?.message, items: [] })) : { source: 'off', reason: 'no-service', items: [] },
    weather ? weather.forView(nowDate).catch(() => ({ source: 'error', reason: 'api' })) : { source: 'off', reason: 'no-service' },
  ]);
  out.incidents = inc;
  out.weather = wx;
  if (!finalFull.length || !out.final) return;
  const plain = () => finalFull.map((t) => ({ ...t, delayMin: delayMinutes(t) }));
  const trips = explainer ? await explainer.forTrips(finalFull, { incidents: inc, weather: wx }).catch(plain) : plain();
  out.final.trips = trips.map(slimWhyTrip);
}
