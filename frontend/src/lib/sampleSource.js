// 미리보기 전용 데이터 공급: 서울시 API 형식의 샘플 응답을 '받은 뒤 흐른 시간'만큼 재생합니다.
// 해석·계산은 실제 서비스와 같은 shared/stopTrips.js · shared/recommend.js를 씁니다. 실시간 데이터가 아닙니다.
import { itemsOf, parseArrivals, parseStations, parseStopSearch, computeTrips } from '@shared/stopTrips.js';
import { SAMPLE_ARRIVALS, SAMPLE_ROUTE_STATIONS, SAMPLE_STOP_SEARCH, SAMPLE_TIME } from '@shared/samples/seoulSample.js';
import { toMin } from '@shared/time.js';
import { searchCourses } from '@shared/courses.js';
import { SAMPLE_COURSES, SAMPLE_COURSE_META } from '@shared/samples/sampleCourses.js';
import { kstMidnight, matchIncidents, normalizeAcc } from '@shared/incidents.js';
import { sampleIncidentRows } from '@shared/samples/incidentSample.js';
import { summarizeNcst } from '@shared/weather.js';
import { sampleNcstItems } from '@shared/samples/weatherSample.js';
import { NO_CAUSE_TEXT, buildFacts, causeWords, delayMinutes, hasEvidence, josa, josaWa, ruleText } from '@shared/explain.js';
import { KOOKMIN_GATE, TRANSIT, distanceM, fallbackText, isLateNight, legEnds, parseOdsayResult, planTransit, staleText, wantsLive } from '@shared/transitPlan.js';
import { SAMPLE_ODSAY_ORIGIN, SAMPLE_ODSAY_RESPONSE, SAMPLE_ORIGINS } from '@shared/samples/odsaySample.js';
import { exampleSubwayJson, parseSubwayArrivals, trainsForLeg } from '@shared/subwayArrivals.js';

export { SAMPLE_COURSE_META };
/** 미리보기 수업 검색: 샘플 강의에서 찾음(실제 강의 목록 아님) */
export const searchSampleCourses = (q) => searchCourses(SAMPLE_COURSES, q);

export const SAMPLE_START_MIN = toMin(SAMPLE_TIME.hhmm);
export const SAMPLE_WEEKDAY = SAMPLE_TIME.weekday;
const STATIONS = Object.fromEntries(Object.entries(SAMPLE_ROUTE_STATIONS).map(([k, v]) => [k, parseStations(itemsOf(v))]));
const STOPS = parseStopSearch(itemsOf(SAMPLE_STOP_SEARCH));

export function sampleSearch(q) {
  const s = q.replace(/\s/g, '');
  return STOPS.filter((st) => !s || st.name.replace(/\s/g, '').includes(s));
}

/** 샘플 응답 시각에서 elapsedSec초 지난 시점의 국민대행 노선(지나간 차는 배차간격으로 다음 차를 채움) */
export function sampleTrips(arsId, elapsedSec) {
  const raw = SAMPLE_ARRIVALS[arsId];
  if (!raw) return [];
  const arrivals = parseArrivals(itemsOf(raw)).map((a) => {
    const term = Math.max(60, (a.termMin || 10) * 60);
    const times = [...a.etasSec];
    while (times.length < 2) times.push((times[times.length - 1] ?? 0) + term);
    let shifted = times.map((s) => s - elapsedSec);
    for (let guard = 0; shifted[0] <= 0 && guard < 500; guard++) { shifted.shift(); shifted.push(shifted[shifted.length - 1] + term); }
    return { ...a, etasSec: shifted.slice(0, 2) };
  });
  return computeTrips({ arrivals, stationsByRoute: STATIONS, boardArsId: arsId });
}

/**
 * 미리보기 예시 돌발정보: 서울 열린데이터광장 AccInfo 형식의 예시 행 → 실제 서비스와 같은 해석 · 경로 매칭(shared/incidents.js).
 * 미리보기 시계(오늘 날짜 + 샘플 시각) 기준. busSource가 'mock'(실시간 실패 배지)이면 서버처럼 1건만, 점선으로.
 * @param {'all'|'campus'|'none'} scenario
 */
export function sampleIncidents(trips, minutes, scenario = 'all', busSource = 'seoul') {
  const nowMs = kstMidnight(Date.now()) + Math.round(minutes * 60_000);
  const items = matchIncidents(sampleIncidentRows(nowMs, scenario).map(normalizeAcc).filter(Boolean), { trips, nowMs });
  const mock = busSource === 'mock';
  return { source: mock ? 'mock' : 'sample', reason: 'example', items: mock ? items.slice(0, 1) : items, nowMs };
}

/**
 * 미리보기 예시 날씨: 기상청 초단기실황 항목 형식의 예시 값 → 실제 서비스와 같은 해석(shared/weather.js). 실시간 아님.
 * @param {'rain'|'snow'|'clear'} kind
 */
export function sampleWeather(minutes, kind = 'rain', busSource = 'seoul') {
  const nowMs = kstMidnight(Date.now()) + Math.round(minutes * 60_000);
  const { raw, ...w } = summarizeNcst(sampleNcstItems(nowMs, kind));
  return { source: busSource === 'mock' ? 'mock' : 'sample', reason: 'example', ...w, nowMs };
}

/**
 * 미리보기 예시 'AI 문장'(실제 AI 응답 아님): 화면에서 AI 태그 모양을 보여 주려고 사실(facts)로 만든 문장.
 * 실제 서비스에서는 서버가 Gemini에 같은 사실을 넘겨 문장을 받습니다.
 * v2.2.6 실제 서비스의 규칙과 같게: 막히는 곳(사실)을 먼저 말하고, 원인일 수 있는 것은 따로 '…영향일 수 있어요'(원인을 결과에 잇지 않음)
 */
export function exampleAiText(f) {
  const place = f['가장 느린 도로'], wx = f.날씨, kinds = causeWords(f).filter((w) => w !== wx);
  const much = f['막힘 정도'] === '혼잡' ? '많이 ' : '';
  const causes = [...kinds, wx].filter(Boolean); // 돌발 종류 먼저, 날씨 다음(예: '공사와 비')
  if (!place && !causes.length) return NO_CAUSE_TEXT;
  const maybe = causes.length === 2 ? `${causes[0]}${josaWa(causes[0])} ${causes[1]} 영향일 수 있어요.` : `${causes.join(' · ')} 영향일 수 있어요.`;
  if (!place) return `버스가 평소보다 느려요. ${maybe}`;
  if (!causes.length) return `${place}에서 버스가 ${much}느려요. 특이 원인은 확인되지 않았어요.`;
  return `${place}${josa(place)} ${much}막혀요. ${maybe}`;
}

/**
 * 미리보기 '왜 늦나요?': 노선마다 지연 분(실제 서비스와 같은 계산) + 막힐 때 예시 설명.
 * variant 'ai' = AI 태그 모양(예시 문장) · 'rule' = 기본 안내(AI 실패 · 한도 초과 때 모양). 버스가 예시 데이터(mock)면 서버처럼 예시 안내
 */
export function sampleExplain(trips, { incidents, weather, busSource = 'seoul', variant = 'ai' } = {}) {
  return trips.map((t) => {
    const delayMin = delayMinutes(t);
    if (!['normal', 'heavy'].includes(t.congestion)) return { ...t, delayMin };
    const facts = buildFacts(t, { incidents, weather });
    let explain;
    if (busSource === 'mock') explain = { source: 'example', reason: 'example', text: ruleText(facts) };
    else if (!hasEvidence(facts)) explain = { source: 'rule', reason: 'no-evidence', text: NO_CAUSE_TEXT };
    else if (variant === 'rule') explain = { source: 'rule', reason: 'causal', text: ruleText(facts) }; // v2.2.6 AI가 원인을 단정해 기본 안내로 바꾼 모양
    else explain = { source: 'gemini', model: 'gemini-3.5-flash-lite', text: exampleAiText(facts) };
    return { ...t, delayMin, explain: { ...explain, facts, sample: true } };
  });
}

/* ── v2.0 출발지 환승 경로(미리보기: ODsay · 서울시 실시간 지하철 형식의 예시 응답 · 실제 경로 아님) ── */
/** 출발지 검색: 예시 출발지(홍대입구역) + 국민대 근처 샘플 정류장('700m 안' 안내 확인용) */
export function sampleOriginSearch(q) {
  const s = q.replace(/\s/g, '');
  return [...SAMPLE_ORIGINS, ...STOPS].filter((st) => !s || st.name.replace(/\s/g, '').includes(s));
}
/** '현재 위치' 대신 쓰는 예시 위치 */
export const SAMPLE_GPS = { lat: SAMPLE_ODSAY_ORIGIN.lat, lon: SAMPLE_ODSAY_ORIGIN.lon, label: '예시 위치(홍대입구역 근처)' };
const SAMPLE_PATHS = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths;
// v2.1 미리보기 '근처 국민대행 정류장'(예시 · 실제 거리 아님): 샘플 정류장 두 곳 — 고르면 홈이 샘플 직행 화면으로
const SAMPLE_NEARBY = [
  { arsId: 'S-01', name: '고려대사범대학부속고등학교', distM: 150, walkMin: 3, walkChip: 3, routes: ['171', '1213', '1112'] },
  { arsId: 'S-03', name: '정릉3동주민센터앞', distM: 330, walkMin: 5, walkChip: 5, routes: ['1166'] },
];
/**
 * 경로 검색(예시 응답): 홍대입구역 근처면 예시 경로 3개 · 국민대 700m 안이면 안내 · 그 밖은 '경로 없음'.
 * v2.1 scenario(미리보기 '검색 결과'): ok · stale(한도 초과 → 41일 전 예전 경로) · nearby(한도 초과 → 근처 국민대행 정류장) · none(한도 초과 · 근처 없음)
 */
export function sampleTransitSearch({ lat, lon, name, kind }, { scenario = 'ok', capDemo = false, nowMin = null } = {}) {
  const sc = capDemo ? 'none' : scenario;
  const calls = (n) => ({ today: n, cap: 25, left: 25 - n }); // 예시 호출 수(실제 서비스: 서버의 오늘 ODsay 호출 수)
  const here = { x: lon, y: lat };
  const fb = (reason, n, extra = {}) => ({ ok: false, fallback: 'direct', reason, message: fallbackText(reason, 25), calls: calls(n), sample: true, ...extra });
  if (distanceM(here, KOOKMIN_GATE) < TRANSIT.nearMinM) return fb('near', sc === 'ok' ? 0 : 25); // 700m 안은 ODsay를 부르지 않음
  const origin = { name: name || SAMPLE_GPS.label, lat, lon, kind };
  if (sc === 'stale') return { ok: true, cached: true, stale: true, staleReason: 'cap', ageDays: 41, message: staleText('cap', 41, 25), searchId: 'sample:hongdae', origin, paths: SAMPLE_PATHS, calls: calls(25), sample: true };
  if (sc === 'nearby') return fb('cap', 25, { nearby: { ok: true, radiusM: TRANSIT.nearKuRadiusM, stops: SAMPLE_NEARBY } });
  // v2.2.6 서버처럼: 심야(서울 23:00 ~ 04:30 전, 미리보기 시각)에 근처 국민대행 정류장을 못 찾으면 night 표시
  if (sc === 'none') return fb('cap', 25, { nearby: { ok: true, radiusM: TRANSIT.nearKuRadiusM, stops: [], ...(isLateNight(nowMin) ? { night: true } : {}) } });
  if (distanceM(here, { x: SAMPLE_ODSAY_ORIGIN.lon, y: SAMPLE_ODSAY_ORIGIN.lat }) > 1500) return fb('no-path', 1, { message: '미리보기에는 홍대입구역 예시 경로만 있어요(실제 서비스는 ODsay로 찾음)' });
  return { ok: true, cached: false, searchId: 'sample:hongdae', origin, paths: SAMPLE_PATHS, calls: calls(1), sample: true };
}
const cycle = (m, period, phase) => { let d = (((phase - m) % period) + period) % period; if (d < 0.5) d += period; return d; };
/**
 * 실시간 재료(예시): 서버 /api/transit/live와 같은 모양. 지하철은 서버처럼 출발 30분 전부터만, 버스 · 지하철 도착은 배차간격으로 만든 가상 시각
 * v2.1: 서버처럼 경로 주변 돌발정보 · 날씨 · 마지막 국민대행 버스의 '왜 늦나요?'(예시 문장) — 미리보기 띠의 돌발 · 날씨 · 왜 늦나요 고르기를 그대로 씀.
 *   preview.explain === 'gap'이면 첫 지하철 열차가 늦게 오는 예시(첫 지하철 간격 한 줄 확인용)
 */
export function sampleTransitLive(route, now, { cls, walkTable, marginMin, personalOffsetMin, preview = {}, departedMin = null } = {}) {
  if (!route) return null;
  const { first, last } = legEnds(route), legs = route.legs, m = now.minutes;
  const out = { fetchedAt: new Date().toISOString(), first: null, final: null, sample: true };
  const L = legs[last], F = legs[first];
  if (L?.kind === 'bus') {
    const term = L.intervalMin || 9, next = cycle(m, term, 4);
    // 예시 구간 값(지연 분 · 가장 느린 도로 계산용) — 차내 시간은 그대로(미리보기 시각이 바뀌지 않게)
    const trip = { no: L.no, type: L.typeLabel, etasSec: [next * 60, (next + term) * 60], termMin: term, msgs: [], ended: false, inVehicleMin: Math.max(1, L.min - 1), gate: '정문', congestion: 'normal',
      boardName: L.from.name, alightName: '국민대학교앞', distM: 1500, intermediateStops: 4, kmh: 11, slowest: { from: '청덕초등학교입구', to: '국민대학교앞', kmh: 9 }, cause: '정릉로', path: L.path || [] };
    const pathTrips = legs.filter((l) => l.kind === 'bus' && l.path?.length >= 2).map((l) => ({ no: l.no, path: l.path }));
    out.incidents = sampleIncidents(pathTrips, m, preview.incidents || 'all');
    out.weather = sampleWeather(m, preview.weather || 'rain');
    const [t] = sampleExplain([trip], { incidents: out.incidents, weather: out.weather, variant: preview.explain === 'rule' ? 'rule' : 'ai' });
    const { path, ...slim } = t; // 서버처럼 경로 좌표는 보내지 않음
    out.final = { i: last, source: 'sample', arsId: L.from.arsId, trips: [slim] };
  }
  if (F?.kind === 'bus' && first !== last) {
    const term = F.intervalMin || 8, next = cycle(m, term, 2);
    out.first = { i: first, kind: 'bus', source: 'sample', buses: [{ no: F.no, etasSec: [next * 60, (next + term) * 60], termMin: term }] };
  }
  if (F?.kind === 'subway') {
    const std = cls ? planTransit({ route, cls, nowMin: m, walkTable, marginMin, personalOffsetMin, departedMin }) : null; // v2.2 출발했으면 그 시각 기준(서버와 같음)
    if (!wantsLive(std, m)) out.first = { i: first, kind: 'subway', source: 'skip', reason: 'not-yet', station: F.from.name, trains: [] };
    else {
      const at = Math.floor(Date.now() / 1000) * 1000; // 받은 시각을 초 단위로(문자열 시각과 맞춰 1초 미만 흔들림 없게)
      const head = (F.intervalMin || 5) + (preview.explain === 'gap' ? 4 : 0), next = cycle(m, head, 1); // 'gap': 열차 간격이 배차간격 + 4분(지연 예시)
      const dest = (F.stations || []).includes(F.way) ? '종착' : F.way || '종착';
      const n = preview.explain === 'gap' ? 4 : 3; // 'gap'은 간격이 길어 한 대 더(탈 열차가 실시간 목록 안에 들도록)
      const json = exampleSubwayJson({ subwayId: F.subwayId || '1002', station: F.from.name, next: F.next, dest, etasSec: Array.from({ length: n }, (_, k) => (next + k * head) * 60), recptnMs: at });
      out.first = { i: first, kind: 'subway', source: 'sample', station: F.from.name, trains: trainsForLeg(parseSubwayArrivals(json, at).rows, F).map((t) => ({ etaSec: t.etaSec, approx: t.approx, dest: t.dest })) };
    }
  }
  return out;
}
