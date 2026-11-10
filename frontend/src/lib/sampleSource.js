// 미리보기 전용 데이터 공급: 서울시 API 형식의 샘플 응답을 '받은 뒤 흐른 시간'만큼 재생합니다.
// 해석·계산은 실제 서비스와 같은 shared/stopTrips.js · shared/recommend.js를 씁니다. 실시간 데이터가 아닙니다.
import { itemsOf, parseArrivals, parseStations, parseStopSearch, computeTrips } from '@shared/stopTrips.js';
import { SAMPLE_ARRIVALS, SAMPLE_ROUTE_STATIONS, SAMPLE_STOP_SEARCH, SAMPLE_TIME } from '@shared/samples/seoulSample.js';
import { toMin } from '@shared/time.js';

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
