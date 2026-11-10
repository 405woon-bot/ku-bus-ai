// 서울시 버스 API 어댑터 — 노선번호 → 노선ID → 경유 정류소(구간 거리·구간 속도) + 승차 정류장 도착정보
//   → 승차~하차 차내 소요시간(liveMin)과 정체 원인(cause)
//
// 사용 API(서울특별시 버스 Open API 활용가이드 기준, 기본 주소 http://ws.bus.go.kr/api/rest)
//   busRouteInfo/getBusRouteList?strSrch=171        노선번호 → busRouteId          (노선정보조회)
//   busRouteInfo/getStaionByRoute?busRouteId=…      seq·arsId·stationNm·fullSectDist(m)·sectSpd  (노선정보조회)
//   stationinfo/getStationByUid?arsId=…             (상세기능명 getStationByUidItem) arrmsg1·traTime1(초)·staOrd  (정류소정보조회)
//   stationinfo/getStationByName?stSrch=…           정류장 이름 검색 stNm·arsId·tmX·tmY                    (정류소정보조회)
//   stationinfo/getStationByPos?tmX=&tmY=&radius=   내 주변 정류장 stationNm·arsId·gpsX·gpsY·dist        (정류소정보조회)
// 인증키는 서버 환경변수로만 받고, 오류 메시지·로그에서 지웁니다.
import { SeoulApiError, parseSeoulResponse } from './seoulResponse.js';
import { causeFromSection } from '../../../shared/corridors.js';
import { computeTrips, parseArrivals, parseArrmsg, parseStations, parseStopSearch, sectionConvention } from '../../../shared/stopTrips.js';

// 응답 해석은 화면 미리보기와 같은 shared/stopTrips.js 코드를 씁니다.
export { parseArrmsg, parseStations, sectionConvention } from '../../../shared/stopTrips.js';

export { SeoulApiError } from './seoulResponse.js';
export const DEFAULT_BASE_URL = 'http://ws.bus.go.kr/api/rest';
export const DWELL_SEC = 20;          // 중간 정류장 한 곳당 정차 시간
const FALLBACK_KMH = 15;              // 구간 속도가 0·비정상일 때 쓰는 값
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const norm = (s) => String(s ?? '').replace(/[\s.·()]/g, '');

/**
 * HTTP 호출기
 * @param {object} o
 * @param {string} o.key        인증키(일반 인증키 Decoding 또는 %가 든 Encoding 키 모두 가능)
 * @param {'xml'|'json'} [o.format='xml']  xml은 API 기본 형식, json은 resultType=json
 * @param {string} [o.keyParam='ServiceKey'] 가이드 예제 URL의 파라미터 이름(요청 표에는 serviceKey로도 표기)
 */
export function createSeoulClient({ key, fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, format = 'xml', keyParam = 'ServiceKey', timeoutMs = 6000 } = {}) {
  const raw = String(key || '').trim();
  const keyValue = raw && (/%[0-9A-Fa-f]{2}/.test(raw) ? raw : encodeURIComponent(raw));
  const redact = (s) => (raw ? String(s).split(raw).join('[KEY]').split(keyValue).join('[KEY]') : String(s));
  const stats = { calls: 0, errors: 0 };

  async function call(path, params = {}) {
    if (!raw) throw new SeoulApiError('no-key', '서울시 버스 API 키(SEOUL_BUS_API_KEY)가 설정되지 않았어요');
    const qs = new URLSearchParams(params);
    if (format === 'json') qs.set('resultType', 'json');
    const url = `${baseUrl}/${path}?${keyParam}=${keyValue}${qs.toString() ? `&${qs}` : ''}`;
    stats.calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      stats.errors++;
      if (e.name === 'AbortError') throw new SeoulApiError('timeout', `서울시 API가 ${timeoutMs / 1000}초 안에 응답하지 않았어요`);
      throw new SeoulApiError('network', `서울시 API에 연결하지 못했어요(${redact(e.message)})`);
    } finally { clearTimeout(timer); }
    try {
      if (res.status === 429) throw new SeoulApiError('quota', '서울시 API 호출 한도를 넘었어요(HTTP 429)');
      if (!res.ok) {
        try { parseSeoulResponse(text); } catch (e) { if (e.kind === 'quota' || e.kind === 'auth') throw e; }
        throw new SeoulApiError('http', `서울시 API가 HTTP ${res.status}로 응답했어요`);
      }
      return parseSeoulResponse(text);
    } catch (e) {
      stats.errors++;
      e.message = redact(e.message);
      throw e;
    }
  }
  return { call, redact, stats, hasKey: Boolean(raw) };
}


/**
 * 승차 seq → 하차 seq 차내 소요시간(분) = Σ(구간거리 ÷ 구간속도) + (중간 정류장 수 × 20초)
 * 속도가 0·비정상(2 km/h 이하, 90 이상)이면 15 km/h로 계산하고 그 구간은 정체 판단에서 뺍니다.
 */
export function inVehicleMinutes(stations, boardSeq, alightSeq, { dwellSec = DWELL_SEC, fallbackKmh = FALLBACK_KMH, convention = sectionConvention(stations) } = {}) {
  const bi = stations.findIndex((s) => s.seq === boardSeq), ai = stations.findIndex((s) => s.seq === alightSeq);
  if (bi < 0 || ai <= bi) throw new SeoulApiError('config', '하차 정류장이 승차 정류장보다 뒤에 있어야 해요');
  const sections = [];
  for (let i = bi + 1; i <= ai; i++) {
    const row = convention === 'arrival' ? stations[i] : stations[i - 1];
    const measured = row.sectSpdKmh > 2 && row.sectSpdKmh < 90;
    const kmh = measured ? row.sectSpdKmh : fallbackKmh;
    sections.push({ from: stations[i - 1].name, to: stations[i].name, seq: stations[i].seq, distM: row.sectDistM, kmh, measured, minutes: row.sectDistM / ((kmh * 1000) / 60) });
  }
  const movingMin = sections.reduce((a, s) => a + s.minutes, 0);
  const intermediateStops = ai - bi - 1;
  const dwellMin = (intermediateStops * dwellSec) / 60;
  const pool = sections.filter((s) => s.measured);
  const slowest = (pool.length ? pool : sections).reduce((a, b) => (b.kmh < a.kmh ? b : a));
  return { minutes: movingMin + dwellMin, movingMin, dwellMin, distM: sections.reduce((a, s) => a + s.distM, 0), intermediateStops, sections, slowest, convention };
}


const CONGESTION = { 3: '여유', 4: '보통', 5: '혼잡' };
/** getStationByUid 응답에서 이 노선의 도착 예정 정보(첫째·둘째 버스) */
export function parseArrival(items, { busRouteId, no }) {
  const it = items.find((x) => String(x.busRouteId) === String(busRouteId))
    || items.find((x) => String(x.rtNm || x.busRouteAbrv) === String(no));
  if (!it) return null;
  const bus = (k) => {
    const msg = String(it[`arrmsg${k}`] ?? '').trim();
    const t = num(it[`traTime${k}`]);
    const sec = t > 0 ? t : parseArrmsg(msg);
    if (!msg && sec == null) return null;
    return { sec: sec ?? null, msg, vehId: it[`vehId${k}`] || null, congestion: CONGESTION[it[`congestion${k}`]] ?? null };
  };
  return {
    staOrd: Math.trunc(num(it.staOrd)) || null,
    termMin: num(it.term ?? it.Term) || null,
    first: bus(1), second: bus(2),
    ended: /운행\s*종료/.test(String(it.arrmsg1 ?? '')),
  };
}

/**
 * 노선별 실시간 계산(캐시 사용). cache: { get(key), set(key, value, ttlMs) } — 메모리 또는 Redis
 */
export function createSeoulAdapter({
  client, cache, ttlMs = 30_000, routeIdTtlMs = 12 * 3600_000,
  stationsTtlMs = 5 * 60_000,     // 탑승 정류장 화면용 경유 정류소(구간 거리·속도) 캐시 — 노선정보는 하루 한 번 갱신(가이드)이라 길게
  searchTtlMs = 6 * 3600_000,     // 정류장 이름·주변 검색
  notKuTtlMs = 12 * 3600_000,     // '이 정류장에서 국민대로 안 가는 노선' 기억 → 경유 정류소를 다시 부르지 않음
} = {}) {
  const inflight = new Map();
  async function cached(key, ttl, load) {
    const hit = await cache.get(key);
    if (hit) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = load().then(async (v) => { await cache.set(key, v, ttl); return v; }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /** 노선번호 → 노선ID. 같은 이름이 여럿이면 서울 노선 유형(간선·지선 등)을 먼저 고르고, 노선 설정의 busRouteId가 있으면 그것을 씀 */
  async function routeId(no, explicit) {
    if (/^\d{6,12}$/.test(String(explicit || ''))) return String(explicit);
    return cached(`route:${no}`, routeIdTtlMs, async () => {
      const { items } = await client.call('busRouteInfo/getBusRouteList', { strSrch: String(no) });
      const exact = items.filter((x) => String(x.busRouteNm).trim() === String(no) || String(x.busRouteAbrv).trim() === String(no));
      if (!exact.length) throw new SeoulApiError('config', `${no}번 노선을 서울시 노선 목록에서 찾지 못했어요`);
      const rank = (x) => (['3', '4', '5', '1', '2', '6'].includes(String(x.routeType)) ? 0 : 1);
      return String([...exact].sort((a, b) => rank(a) - rank(b))[0].busRouteId);
    });
  }
  const stations = (id) => cached(`stations:${id}`, ttlMs, async () => parseStations((await client.call('busRouteInfo/getStaionByRoute', { busRouteId: id })).items));
  const arrivalsAt = (arsId) => cached(`arrivals:${arsId}`, ttlMs, async () => (await client.call('stationinfo/getStationByUid', { arsId })).items);
  const stopStations = (id) => cached(`stopstations:${id}`, stationsTtlMs, async () => parseStations((await client.call('busRouteInfo/getStaionByRoute', { busRouteId: id })).items));

  /** 정류장 이름 검색(2글자 이상) */
  const searchStops = (q) => cached(`search:${q}`, searchTtlMs, async () => parseStopSearch((await client.call('stationinfo/getStationByName', { stSrch: q })).items));
  /** 내 주변 정류장(WGS84 좌표, 반경 m) — 가까운 순 */
  const nearStops = (lat, lon, radius = 400) => cached(`near:${lat.toFixed(4)},${lon.toFixed(4)},${radius}`, searchTtlMs, async () =>
    parseStopSearch((await client.call('stationinfo/getStationByPos', { tmX: lon.toFixed(7), tmY: lat.toFixed(7), radius: String(radius) })).items)
      .sort((a, b) => (a.distM || 0) - (b.distM || 0)));

  /** 탑승 정류장 하나 → 국민대로 가는 노선별 실시간 도착·차내 시간·정체·원인 */
  async function stopTrips(arsId) {
    const arrivals = parseArrivals(await arrivalsAt(arsId));
    const stationsByRoute = {};
    await Promise.all([...new Set(arrivals.map((a) => a.busRouteId))].map(async (id) => {
      if ((await cache.get(`notku:${arsId}:${id}`))?.value) return;
      try { stationsByRoute[id] = await stopStations(id); } catch (e) {
        if (['quota', 'auth', 'no-key'].includes(e.kind)) throw e; // 키·한도 문제는 전체 실패로
      }
    }));
    const trips = computeTrips({ arrivals, stationsByRoute, boardArsId: arsId });
    for (const id of Object.keys(stationsByRoute)) {
      if (!trips.some((t) => t.busRouteId === id)) await cache.set(`notku:${arsId}:${id}`, true, notKuTtlMs);
    }
    return trips;
  }

  /**
   * @param {{ no:string, boardArsId:string, alightName?:string, stop?:string, busRouteId?:string, corridor?:string, corridorSeq?:number[] }} route
   */
  async function routeLive(route) {
    const no = String(route.no);
    const board = String(route.boardArsId || '').trim();
    const alightName = String(route.alightName || route.stop || '').trim();
    if (!/^\d{5}$/.test(board)) throw new SeoulApiError('config', `${no}번: 승차 정류장 번호(5자리)를 설정하세요`);
    if (!alightName) throw new SeoulApiError('config', `${no}번: 하차 정류장 이름을 설정하세요`);
    const id = await routeId(no, route.busRouteId);
    const st = await stations(id);
    if (!st.length) throw new SeoulApiError('config', `${no}번 노선의 정류장 목록이 비어 있어요`);
    let arrival = null, arrivalError = null;
    try { arrival = parseArrival(await arrivalsAt(board), { busRouteId: id, no }); } catch (e) {
      if (e.kind === 'quota' || e.kind === 'auth' || e.kind === 'no-key') throw e;
      arrivalError = e.message; // 도착정보가 없어도 차내 소요시간은 계산
    }
    const boards = st.filter((s) => s.arsId === board);
    if (!boards.length) throw new SeoulApiError('config', `${no}번 노선에 승차 정류장 ${board}이(가) 없어요`);
    // 왕복 노선에서 같은 정류장이 두 번 나오면 도착정보의 staOrd(요청 정류소 순번)로 방향을 고름
    const b = (arrival?.staOrd && boards.find((s) => s.seq === arrival.staOrd)) || boards[0];
    const a = st.find((s) => s.seq > b.seq && norm(s.name) === norm(alightName));
    if (!a) throw new SeoulApiError('config', `${no}번: 승차 정류장 뒤에서 하차 정류장 '${alightName}'을(를) 찾지 못했어요`);
    const trip = inVehicleMinutes(st, b.seq, a.seq);
    return {
      busRouteId: id,
      board: { seq: b.seq, name: b.name, arsId: b.arsId },
      alight: { seq: a.seq, name: a.name, arsId: a.arsId },
      trip, cause: causeFromSection(no, trip.slowest, route), arrival, arrivalError,
    };
  }

  /** 정류장 고르기 화면용 */
  async function stationsOf(no, explicitId) {
    const id = await routeId(no, explicitId);
    return { busRouteId: id, stations: await stations(id) };
  }
  return { routeLive, stationsOf, routeId, searchStops, nearStops, stopTrips };
}
