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
import { NO_CAUSE_TEXT, buildFacts, causeWords, delayMinutes, hasEvidence, ruleText } from '@shared/explain.js';

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
 */
export function exampleAiText(f) {
  const place = f['가장 느린 도로'], wx = f.날씨, kinds = causeWords(f).filter((w) => w !== wx);
  const much = f['막힘 정도'] === '혼잡' ? '많이 ' : '';
  if (!place && !wx && !kinds.length) return NO_CAUSE_TEXT;
  if (!place) return `${[wx, ...kinds].filter(Boolean).join(' · ')} 영향으로 버스가 느려졌을 수 있어요.`;
  if (wx && kinds.length) return `${place}에 ${kinds[0]}에다 ${wx}까지 겹쳐 버스가 ${much}막혀요.`;
  if (wx) return `${place}에 ${wx}까지 와서 버스가 ${much}막혀요.`;
  if (kinds.length) return `${place}에 ${kinds[0]}까지 겹쳐 버스가 ${much}막혀요.`;
  return `${place}에서 버스가 ${much}느려요. 특이 원인은 확인되지 않았어요.`;
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
    else if (variant === 'rule') explain = { source: 'rule', reason: 'quota', text: ruleText(facts) };
    else explain = { source: 'gemini', model: 'gemini-3.5-flash-lite', text: exampleAiText(facts) };
    return { ...t, delayMin, explain: { ...explain, facts, sample: true } };
  });
}
