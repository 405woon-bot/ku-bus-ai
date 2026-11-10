// 탑승 정류장 하나 → 국민대(정문·후문)로 가는 노선별 실시간 이동 계산.
// 서버(실제 서울시 응답)와 미리보기(같은 형식의 샘플 응답)가 이 코드를 함께 씁니다.
//
// 쓰는 서울시 버스 API — 공식 활용가이드(서비스 URL http://ws.bus.go.kr/api/rest) 기준 필드
//   정류소 이름 검색  stationinfo/getStationByName?stSrch=        → stId, stNm, tmX·tmY(WGS84), arsId
//   내 주변 정류소    stationinfo/getStationByPos?tmX=&tmY=&radius= → stationId, stationNm, gpsX·gpsY(WGS84), arsId, dist
//   정류소 도착 정보  stationinfo/getStationByUid?arsId=          → 노선별 busRouteId, rtNm, routeType, staOrd, term,
//                                                                  traTime1·2(초), arrmsg1·2("3분12초후[2번째 전]"), congestion1·2
//   노선 경유 정류소  busRouteInfo/getStaionByRoute?busRouteId=    → seq, arsId, stationNm, fullSectDist(m), sectSpd(km/h)
// 구간 값은 '앞 정류소 → 이 정류소' 구간이 도착 정류소 행에 있습니다(가이드 예시: 1번 0·0, 2번 249 m·12 km/h).
// 마지막 행이 0이면 반대로 보고 자동으로 맞춥니다(sectionConvention).
import { causeFromSection } from './corridors.js';
import { EXAMPLE_ROUTES, mockLive } from './transitModel.js';

/** 국민대 하차 정류장 → 캠퍼스 출입문 */
export const KU_STOPS = { 국민대학교앞: '정문', 국민대앞: '정문', 국민대후문: '후문' };
export const DWELL_SEC = 20;        // 중간 정류장 한 곳당 정차 시간
export const FALLBACK_KMH = 15;     // 구간 속도가 0·비정상(2 km/h 이하, 90 이상)일 때 쓰는 값
const ROUTE_TYPE = { 1: '공항', 2: '마을', 3: '간선', 4: '지선', 5: '순환', 6: '광역', 7: '인천', 8: '경기', 0: '공용' };
const BUS_CROWD = { 3: '여유', 4: '보통', 5: '혼잡' }; // 차내 혼잡(congestion1·2)

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const norm = (s) => String(s ?? '').replace(/[\s.·()]/g, '');
const KU_NORM = Object.fromEntries(Object.entries(KU_STOPS).map(([k, v]) => [norm(k), v]));
/** 정류장 이름 → '정문' | '후문' | null (띄어쓰기 차이 무시) */
export const gateOf = (name) => KU_NORM[norm(name)] || null;

/** 샘플(JSON 객체) 응답 → itemList 배열. 실제 서버 응답(XML/JSON 글자)은 backend/src/transit/seoulResponse.js가 해석합니다. */
export function itemsOf(json) {
  const h = json?.msgHeader;
  const code = h?.headerCd == null ? '0' : String(h.headerCd);
  if (['3', '4', '7', '8'].includes(code)) return []; // 정류소·노선 없음, 결과 없음, 운행 종료
  if (code !== '0') throw new Error(`서울시 API 오류 ${code}: ${h.headerMsg || ''}`);
  const list = json?.msgBody?.itemList;
  return Array.isArray(list) ? list : list ? [list] : [];
}

/** 안내 문구 → 초. "3분12초후[2번째 전]" → 192, "곧 도착" → 30, "운행종료"·"출발대기" → null */
export function parseArrmsg(msg) {
  const s = String(msg ?? '').trim();
  if (!s) return null;
  if (/곧\s*도착/.test(s)) return 30;
  const m = /(?:(\d+)\s*분)?\s*(?:(\d+)\s*초)?\s*후/.exec(s);
  return m && (m[1] || m[2]) ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
}

/** 이름 검색(getStationByName: stNm·tmX·tmY)과 좌표 검색(getStationByPos: stationNm·gpsX·gpsY·dist) 응답을 함께 처리 */
export function parseStopSearch(items) {
  const seen = new Set();
  return items
    .map((it) => ({ arsId: String(it.arsId ?? '').trim(), stId: String(it.stId ?? it.stationId ?? ''), name: String(it.stNm ?? it.stationNm ?? '').trim(),
      lat: num(it.tmY ?? it.gpsY), lon: num(it.tmX ?? it.gpsX), distM: num(it.dist) }))
    .filter((s) => s.arsId && s.arsId !== '0' && s.name && !seen.has(s.arsId) && seen.add(s.arsId));
}

/** getStationByUid → 노선별 도착 예정(첫째·둘째 버스, 초) */
export function parseArrivals(items) {
  return items.map((it) => {
    const msg1 = String(it.arrmsg1 ?? '').trim(), msg2 = String(it.arrmsg2 ?? '').trim();
    const sec = (k, msg) => { const t = num(it[`traTime${k}`]); return t > 0 ? t : parseArrmsg(msg); };
    const term = num(it.term ?? it.Term);
    return {
      busRouteId: String(it.busRouteId ?? ''), no: String(it.rtNm || it.busRouteAbrv || ''), type: ROUTE_TYPE[it.routeType] || '버스',
      staOrd: Math.trunc(num(it.staOrd)) || null, nextStop: String(it.nxtStn || ''), termMin: term > 0 ? term : null,
      etasSec: [sec(1, msg1), sec(2, msg2)].filter((v) => v != null && Number.isFinite(v)),
      msgs: [msg1, msg2], crowd: BUS_CROWD[it.congestion1] ?? null, ended: /운행\s*종료/.test(msg1),
    };
  }).filter((a) => a.busRouteId && a.no);
}

/** getStaionByRoute → 정류장 목록(순번 정렬) */
export function parseStations(items) {
  return items.map((x) => ({
    seq: Math.trunc(num(x.seq)),
    arsId: String(x.arsId || x.stationNo || '').trim(),
    stId: String(x.station ?? '').trim(),
    name: String(x.stationNm ?? '').trim(),
    sectDistM: num(x.fullSectDist) || 0,   // 정류소간 거리(m) — 가이드 예제: 1번 정류장 0, 2번 249
    sectSpdKmh: num(x.sectSpd) || 0,       // 구간속도(km/h)
    direction: String(x.direction ?? ''),
    turn: String(x.transYn ?? '') === 'Y',
    lon: num(x.gpsX), lat: num(x.gpsY),
  })).filter((s) => Number.isFinite(s.seq)).sort((a, b) => a.seq - b.seq);
}

/**
 * 구간 값이 어느 행에 붙어 있는지: 가이드 예제처럼 첫 정류장의 fullSectDist가 0이면
 * '직전 정류장 → 이 정류장' 구간이 이 행에 있음(arrival). 마지막 행이 0이면 반대(departure).
 */
export function sectionConvention(stations) {
  if (stations.length && stations[0].sectDistM === 0) return 'arrival';
  if (stations.length && stations[stations.length - 1].sectDistM === 0) return 'departure';
  return 'arrival';
}

/** 평균 통과 속도 → 정체 정도(도심 일반도로 기준 가정, 필요하면 조정) */
export const CONGESTION_KMH = { smooth: 20, normal: 12 };
export function congestionLevel(kmh) {
  if (!Number.isFinite(kmh)) return 'unknown';
  return kmh >= CONGESTION_KMH.smooth ? 'smooth' : kmh >= CONGESTION_KMH.normal ? 'normal' : 'heavy';
}
export const CONGESTION = { smooth: { label: '원활', tone: 'ok' }, normal: { label: '보통', tone: 'warn' }, heavy: { label: '혼잡', tone: 'danger' }, unknown: { label: '정보 없음', tone: 'muted' } };

/** 위치 bi → ai 차내 시간 = Σ 구간거리 ÷ 구간속도 + 중간 정류장 × 20초, 가장 느린(실측) 구간 */
export function segmentTrip(stations, bi, ai, { dwellSec = DWELL_SEC, fallbackKmh = FALLBACK_KMH, convention = sectionConvention(stations) } = {}) {
  let moving = 0, dist = 0, slowest = null;
  for (let k = bi + 1; k <= ai; k++) {
    const row = convention === 'arrival' ? stations[k] : stations[k - 1];
    const measured = row.sectSpdKmh > 2 && row.sectSpdKmh < 90, v = measured ? row.sectSpdKmh : fallbackKmh;
    moving += row.sectDistM / ((v * 1000) / 60); dist += row.sectDistM;
    // 정체 원인 후보: 실제 속도 값이 있는 구간 중 가장 느린 곳
    if (measured && row.sectDistM > 0 && (!slowest || row.sectSpdKmh < slowest.kmh)) slowest = { from: stations[k - 1].name, to: stations[k].name, kmh: row.sectSpdKmh, seq: stations[k].seq };
  }
  const intermediateStops = ai - bi - 1;
  return { movingMin: moving, inVehicleMin: moving + (intermediateStops * dwellSec) / 60, distM: dist, intermediateStops, slowest, kmh: moving > 0 ? (dist / moving) * 0.06 : NaN };
}

/**
 * 노선 경유 정류소에서 승차 정류장 → (진행 방향으로) 처음 만나는 국민대 정류장까지. 국민대에 가지 않으면 null.
 * 같은 정류장을 두 번 지나는 노선은 도착 정보의 staOrd(= seq)로 승차 위치를 고릅니다.
 */
export function tripFromStations(stations, { boardArsId, boardSeq, maxMin = 120, ...opt }) {
  let bi = Number.isFinite(boardSeq) ? stations.findIndex((s) => s.seq === boardSeq && s.arsId === String(boardArsId)) : -1;
  if (bi < 0) bi = stations.findIndex((s) => s.arsId === String(boardArsId));
  if (bi < 0) return null;
  for (let j = bi + 1; j < stations.length; j++) {
    const gate = gateOf(stations[j].name);
    if (!gate) continue;
    const seg = segmentTrip(stations, bi, j, opt);
    if (seg.inVehicleMin > maxMin) return null;
    return { boardName: stations[bi].name, alightName: stations[j].name, gate, stopsAway: j - bi, distM: Math.round(seg.distM),
      inVehicleMin: seg.inVehicleMin, intermediateStops: seg.intermediateStops, kmh: seg.kmh, congestion: congestionLevel(seg.kmh), slowest: seg.slowest };
  }
  return null;
}

/** 정류장 도착 정보 + 노선별 경유 정류소 → 국민대로 가는 노선만(가장 빨리 오는 순), 정체 원인 포함 */
export function computeTrips({ arrivals, stationsByRoute, boardArsId }) {
  const out = [];
  for (const a of arrivals) {
    const st = stationsByRoute[a.busRouteId];
    const t = st && tripFromStations(st, { boardArsId, boardSeq: a.staOrd });
    if (!t) continue;
    const cause = t.slowest ? causeFromSection(a.no, t.slowest) : null; // 15 km/h 미만 구간만 '정체 원인'으로 봄
    out.push({ ...a, ...t, cause: cause?.text ?? null });
  }
  return out.sort((x, y) => (x.etasSec[0] ?? 1e9) - (y.etasSec[0] ?? 1e9));
}

/**
 * 서울시 실시간을 받지 못할 때 쓰는 예시 노선(shared/transitModel.js 시나리오). 실제 운행 정보가 아닙니다.
 * 도착 예정은 배차간격으로 만든 가상 시각이고, 화면·알림은 '예시 데이터'로 표시합니다.
 */
const MOCK_BUS = { 171: { term: 9, offset: 4 }, 1711: { term: 12, offset: 7 }, 1112: { term: 14, offset: 2 } };
export function mockTrips(nowMin, scenario = 'jeongneung') {
  const m = mockLive(EXAMPLE_ROUTES, scenario, nowMin);
  return m.routes.map((r) => {
    const { term, offset } = MOCK_BUS[r.no] || { term: 10, offset: 0 };
    const first = (((offset - nowMin) % term) + term) % term || term; // 다음 차까지 분
    const delay = r.liveMin - r.usualMin;
    const congestion = delay >= 5 ? 'heavy' : delay >= 2 ? 'normal' : 'smooth';
    return {
      busRouteId: `example-${r.no}`, no: r.no, type: r.type, staOrd: null, nextStop: '', termMin: term,
      etasSec: [first * 60, (first + term) * 60], msgs: [], crowd: null, ended: false,
      boardName: null, alightName: r.stop, gate: r.gate, stopsAway: null, distM: null, intermediateStops: null,
      inVehicleMin: r.liveMin, kmh: NaN, congestion, slowest: null,
      cause: congestion !== 'smooth' && (m.roadDelays[r.corridor] || 0) >= 2 ? r.corridor : null, example: true,
    };
  }).sort((x, y) => x.etasSec[0] - y.etasSec[0]);
}
