// 출발지 환승 경로(ODsay 대중교통 길찾기) → '몇 시에 나가면 늦지 않는가'. 서버(출발 알림)와 화면이 같은 코드입니다.
//
//   경로 = ODsay subPath를 줄인 구간 목록: 도보(trafficType 3) · 지하철(1) · 버스(2)
//   한 번 출발해 보기(simulate): 출발 → 도보 → [기다림 → 탑승 → 이동] → 환승 도보(+3분 안전 여유) → … → 강의실
//     첫 탑승 구간: 실시간(지하철 = 서울시 실시간 도착, 버스 = 서울시 버스 도착) — 승강장까지 2분 여유를 두고 탈 수 있는 첫 열차
//     마지막 버스(→ 국민대): 서울시 실시간 버스(기존 직행 계산과 같은 차내 시간 · 하차 문 → 강의 건물 도보)
//     그 밖이나 실시간이 없을 때: ODsay 배차간격의 절반 + 1분을 기다린다고 보고(없으면 지하철 4분 · 버스 6분) ODsay 구간 시간
//     v2.6.0 환승 지하철(첫 탑승이 아닌 지하철): '출발했어요!' 뒤 기기가 알려 준 '다음 탈 환승 지하철' 한 곳만, 예정 탑승 ±15분에 서울시 실시간(rt.mid)
//       — 첫 지하철과 같은 규칙(승강장 2분 뒤 첫 열차, 그 뒤는 배차간격으로 이어 붙인 예상)으로 탑승 시각을 정하고 뒤 구간은 그 시각부터 다시 계산
//   추천 = 수업 시작 '여유(5분)' 전까지 강의실에 닿는 가장 늦은 출발(내 걸음 반영 personalOffsetMin을 도착에 더함)
import { toMin, toHHMM } from './time.js';
import { appliedOffset } from './arrival.js';
import { busTimes, walkToBuilding, DEFAULTS } from './recommend.js';
import { liveSupport, stationKey } from './subwayArrivals.js';

export const KOOKMIN_GATE = Object.freeze({ x: 126.9972, y: 37.6109, name: '국민대학교 정문' });
export const TRANSIT = Object.freeze({
  transferSafetyMin: 3,       // 환승 1회당 안전 여유
  platformMin: 2,             // 지하철역 입구 → 승강장(실시간 열차를 잡을 때)
  defaultWait: { subway: 4, bus: 6 },
  maxWaitMin: 12,
  cacheRadiusM: 300,          // 같은 출발지로 보는 거리(GPS)
  nearMinM: 700,              // ODsay: 출발 · 도착이 700m 안이면 경로 없음
  maxPaths: 3,
  liveBeforeMin: 30,          // 지하철 실시간은 출발 30분 전부터(호출 아끼기)
  liveAfterMin: 20,
  gapExtraMin: 3,             // v2.1 첫 지하철 열차 간격이 배차간격보다 이만큼(분) 길면 '왜 늦나요?' 한 줄
  nearKuRadiusM: 400,         // v2.1 경로를 못 찾으면 출발지 이 거리 안의 국민대행 정류장으로 직행 안내
  pathMaxPoints: 60,          // v2.1 버스 구간 경유 정류장 좌표(돌발정보 매칭용) 최대 개수
  departBeforeMin: 60,        // v2.2 [출발했어요!]는 추천 출발 이만큼(분) 전부터 수업 시작 전까지
  midWindowMin: 15,           // v2.6.0 환승 지하철 실시간: 예정 탑승 시각 −15분 ~ +15분에만
  midHintEarlyMin: 15,        // v2.6.0 기기가 알려 준 기준 시각은 서버 표준값의 −15분 ~
  midHintLateMin: 30,         //   +30분 안일 때만 받음(밖이면 서버 표준값)
});
// v2.2 '출발했어요!' 뒤: 탈 시각이 이만큼(분) 안으로 다가오거나 지나면 그 구간은 '탔음'으로 고정(실시간 목록에서 그 차가 빠지기 전에)
const PIN_LOCK_MIN = 0.5;

/**
 * v2.2.6 심야(서울 시각 23:00 ~ 04:30 전): 버스 운행이 대부분 끝나 실시간 도착 정보가 비어 있을 수 있는 시간.
 * 막차 · 첫차 시각은 노선마다 달라서 정확한 운행 여부는 모름 → 화면은 '~수 있어요'로만 안내(단정하지 않음)
 */
export const LATE_NIGHT = Object.freeze({ fromMin: 23 * 60, toMin: 4 * 60 + 30 });
/** 서울 시각(자정부터 분)이 심야인지 */
export const isLateNight = (minutes) => Number.isFinite(minutes) && (minutes >= LATE_NIGHT.fromMin || minutes < LATE_NIGHT.toMin);
export const NIGHT_NEARBY_TEXT = '버스 운행이 끝난 시간이라 근처 국민대행 정류장을 확인하기 어려울 수 있어요. 아침에 다시 찾아 주세요.';
/**
 * 근처 국민대행 정류장을 하나도 못 찾았을 때 화면 문구(서버 nearKu 결과 그대로 — 서버와 미리보기가 같은 글).
 * 심야 표시(night)는 서버가 서울 시각으로 정하고, 정류장을 확인했는데 못 찾았을 때만 붙음(키 · 한도 문제면 붙지 않음)
 */
export function nearbyNoneText(nearby) {
  if (!nearby) return '';
  if (nearby.night) return NIGHT_NEARBY_TEXT;
  return nearby.ok ? `출발지 ${nearby.radiusM || TRANSIT.nearKuRadiusM}m 안에 국민대로 바로 가는 버스 정류장이 없어요` : '근처 버스 정류장을 확인하지 못했어요';
}

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** 두 좌표 사이 거리(m) */
export function distanceM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.y - a.y) * r, dLon = (b.x - a.x) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.y * r) * Math.cos(b.y * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 경로를 못 찾을 때 화면 문구 — 서버(ODsay)와 미리보기가 같은 글.
 * v2.1: '직행으로 안내해요'를 미리 약속하지 않음 → 근처 국민대행 정류장이 있을 때만 화면이 그 안내를 덧붙임(nearbyText)
 */
const FALLBACK = {
  cap: (cap) => `오늘 새 경로 검색 한도(${cap}회)를 다 썼어요. 이 출발지는 내일부터 찾을 수 있어요`,
  'no-key': () => '서버에 ODSAY_API_KEY가 없어 경로를 찾을 수 없어요',
  near: () => '국민대까지 700m 안이라 대중교통 경로가 없어요 — 걸어가는 편이 빨라요',
  'no-path': () => '이 출발지에서 국민대까지 대중교통 경로를 찾지 못했어요',
  'out-of-area': () => '서비스 지역 밖이에요. 수도권 출발지만 찾을 수 있어요',
  auth: () => 'ODsay 키 인증에 실패했어요 — ODsay 콘솔의 URI(웹) 주소와 Render의 ODSAY_API_KEY를 확인해 주세요',
  store: () => '저장소(Upstash)에 연결하지 못해 오늘 호출 수를 확인할 수 없어요. 한도를 지키려고 경로 검색을 잠시 쉬어요',
  error: () => 'ODsay에서 경로를 받지 못했어요. 잠시 뒤 다시 찾아 주세요',
  bad: () => '출발지 위치가 올바르지 않아요',
};
export const fallbackText = (reason, cap = 25) => (FALLBACK[reason] || FALLBACK.error)(cap);
/** 근처 국민대행 정류장을 찾아볼 만한 이유(700m 안 · 좌표 오류 · 지역 밖은 아님) */
export const NEARBY_REASONS = Object.freeze(['cap', 'no-key', 'no-path', 'auth', 'store', 'error']);
/** v2.1 예전에 찾아 둔 경로(30~90일)를 쓸 때 화면 문구 */
export function staleText(reason, ageDays, cap = 25) {
  const why = reason === 'cap' ? `오늘 새 경로 검색 한도(${cap}회)를 다 써서` : reason === 'no-key' ? '지금은 새 경로를 찾을 수 없어서' : 'ODsay에서 새 경로를 받지 못해서';
  return `${why}, ${ageDays}일 전에 찾아 둔 경로를 보여 드려요`;
}

/* ── 색 · 이름 ── */
// 막대(사용자 지정): 도보 회색 · 간선 파랑 · 지하철 하늘색 · 지선/일반 초록 (+ 광역 빨강 · 순환 노랑)
export const MODE_COLOR = { walk: '#B4BBC5', subway: '#41ADE6', blue: '#2F64D6', green: '#3E9B4F', red: '#D0342C', yellow: '#C98A00', other: '#7A6AD8' };
// ODsay 버스 노선 타입(type) → 이름
export const BUS_TYPE = { 1: '일반', 2: '좌석', 3: '마을', 4: '직행좌석', 5: '공항', 6: '간선급행', 10: '외곽', 11: '간선', 12: '지선', 13: '순환', 14: '광역', 15: '급행', 16: '관광', 20: '농어촌', 22: '시외', 26: '급행간선' };
export function busColor(label) {
  if (/간선|좌석|외곽/.test(label) && !/직행/.test(label)) return MODE_COLOR.blue;
  if (/지선|마을|일반|농어촌/.test(label)) return MODE_COLOR.green;
  if (/광역|급행|직행|시외/.test(label)) return MODE_COLOR.red;
  if (/순환/.test(label)) return MODE_COLOR.yellow;
  return label === '공항' || label === '관광' ? MODE_COLOR.other : MODE_COLOR.blue;
}
// ODsay 지하철 노선 이름 → 서울시 실시간 subwayId · 짧은 이름 · 노선 색(공식 노선 색)
const LINES = [
  [/인천\s*1/, null, '인천1호선', '#7CA8D5'], [/인천\s*2/, null, '인천2호선', '#ED8B00'],
  [/신분당/, '1077', '신분당선', '#D4003B'], [/수인|분당/, '1075', '수인분당선', '#FABE00'], [/공항/, '1065', '공항철도', '#0090D2'],
  [/경의|중앙/, '1063', '경의중앙선', '#77C4A3'], [/경춘/, '1067', '경춘선', '#0C8E72'], [/우이|신설/, '1092', '우이신설선', '#B0CE18'],
  [/서해/, '1093', '서해선', '#8FC31F'], [/경강/, '1081', '경강선', '#0054A6'], [/신림/, '1094', '신림선', '#6789CA'], [/GTX/i, '1032', 'GTX-A', '#9A6292'],
  [/김포/, null, '김포골드라인', '#A17800'], [/의정부/, null, '의정부경전철', '#FDA600'], [/에버라인|용인/, null, '용인에버라인', '#509F22'],
];
const NUM_COLOR = { 1: '#0052A4', 2: '#00A84D', 3: '#EF7C1C', 4: '#00A5DE', 5: '#996CAC', 6: '#CD7C2F', 7: '#747F00', 8: '#E6186C', 9: '#BDB092' };
export function subwayLine(lane) {
  const name = str(lane?.name), code = num(lane?.subwayCode), city = num(lane?.subwayCityCode);
  for (const [re, id, short, color] of LINES) if (re.test(name)) return { subwayId: id, short, color, name };
  const m = /(\d)\s*호선/.exec(name);
  const n = m ? Number(m[1]) : code >= 1 && code <= 9 ? code : null;
  if (n && (city == null || city === 1000)) return { subwayId: `100${n}`, short: `${n}호선`, color: NUM_COLOR[n], name };
  return { subwayId: null, short: name.replace(/^수도권\s*/, '') || '지하철', color: MODE_COLOR.subway, name };
}
/** 밝은 배경에는 진한 글자 */
export function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(str(hex));
  if (!m) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#1D2430' : '#FFFFFF';
}

/* ── ODsay 응답 해석 ── */
const arsOf = (v) => { const d = str(v).replace(/[^0-9]/g, ''); return /^\d{5}$/.test(d) ? d : ''; };
const point = (name, x, y, extra = {}) => ({ name: str(name), x: num(x), y: num(y), ...extra });

/** ODsay 오류(HTTP 200에 error가 목록 또는 객체로 옴) → { code, message } 또는 null */
export function odsayError(json) {
  const e = json?.error;
  if (!e) return null;
  const x = Array.isArray(e) ? e[0] || {} : e;
  return { code: str(x.code), message: str(x.message || x.msg) };
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;
/**
 * v2.1 버스 구간이 지나는 정류장 좌표(ODsay passStopList.stations의 x · y) → [{ lat, lon, name }] — 경로 주변 돌발정보 매칭용.
 * 좌표가 없거나 이상한 정류장은 빼고, 너무 길면 고르게 줄임(처음 · 끝은 남김)
 */
export function busPath(stations) {
  const pts = (Array.isArray(stations) ? stations : [])
    .map((x) => ({ lat: num(x?.y), lon: num(x?.x), name: str(x?.stationName) }))
    .filter((p) => p.lat >= 33 && p.lat <= 39 && p.lon >= 124 && p.lon <= 132)
    .map((p) => ({ lat: r5(p.lat), lon: r5(p.lon), name: p.name.slice(0, 30) }));
  const max = TRANSIT.pathMaxPoints;
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => pts[Math.round(k * step)]);
}

/** ODsay path 하나 → 줄인 경로(화면 · 저장 · 계산용). 쓸 수 없는 경로면 null */
export function parseOdsayPath(p, index = 0) {
  const legs = [];
  for (const s of Array.isArray(p?.subPath) ? p.subPath : []) {
    const t = num(s?.trafficType), min = Math.max(0, num(s?.sectionTime) ?? 0), distM = Math.max(0, num(s?.distance) ?? 0);
    if (t === 3) { if (min > 0 || distM > 0) legs.push({ kind: 'walk', min, distM }); continue; }
    if (t !== 1 && t !== 2) return null; // 도시간(기차 · 고속버스 등)은 다루지 않음
    const lane = (Array.isArray(s.lane) ? s.lane : s.lane ? [s.lane] : []).filter(Boolean);
    const stations = Array.isArray(s.passStopList?.stations) ? s.passStopList.stations : [];
    const interval = num(s.intervalTime) ?? num(lane[0]?.intervalTime);
    const base = {
      min, distM, stops: num(s.stationCount), intervalMin: interval > 0 ? interval : null,
      from: point(s.startName, s.startX, s.startY), to: point(s.endName, s.endX, s.endY),
    };
    if (t === 1) {
      const L = subwayLine(lane[0]);
      legs.push({ kind: 'subway', ...base, line: L.short, lineName: L.name, subwayId: L.subwayId, color: L.color,
        way: str(s.way), wayCode: num(s.wayCode), next: str(stations[1]?.stationName), stations: stations.slice(0, 80).map((x) => str(x.stationName)) });
    } else {
      const buses = lane.map((l) => ({ no: str(l.busNo), label: BUS_TYPE[num(l.type)] || '버스' })).filter((b) => b.no);
      if (!buses.length) return null;
      const path = busPath(stations);
      legs.push({ kind: 'bus', ...base, no: buses[0].no, typeLabel: buses[0].label, color: busColor(buses[0].label), buses: buses.slice(0, 6).map((b) => b.no),
        from: { ...base.from, arsId: arsOf(s.startArsID ?? stations[0]?.arsID) }, to: { ...base.to, arsId: arsOf(s.endArsID ?? stations[stations.length - 1]?.arsID) },
        ...(path.length >= 2 ? { path } : {}) });
    }
  }
  const transit = legs.filter((l) => l.kind !== 'walk');
  if (!transit.length) return null;
  const info = p?.info || {};
  return {
    id: `p${index}`, totalMin: num(info.totalTime) ?? legs.reduce((a, l) => a + l.min, 0), payment: num(info.payment), walkM: num(info.totalWalk),
    transfers: transit.length - 1, legs,
    title: transit.map((l) => (l.kind === 'bus' ? l.no : l.line)).join(' → '),
  };
}

/** ODsay 응답 전체 → { ok, paths } 또는 { ok:false, error } */
export function parseOdsayResult(json) {
  const err = odsayError(json);
  if (err) return { ok: false, error: err };
  const paths = json?.result?.path;
  if (!Array.isArray(paths)) return { ok: false, error: { code: 'format', message: '응답 형식이 달라요' } };
  const out = [];
  for (const p of paths) {
    const r = parseOdsayPath(p, out.length);
    if (r) out.push(r);
    if (out.length >= TRANSIT.maxPaths) break;
  }
  return out.length ? { ok: true, paths: out } : { ok: false, error: { code: '-99', message: '쓸 수 있는 경로가 없어요' } };
}

/* ── 계산 ── */
/** 기다리는 시간(실시간이 없을 때): 배차간격의 절반 + 1분, 없으면 지하철 4분 · 버스 6분 */
export function stdWait(leg) {
  const iv = num(leg?.intervalMin);
  const w = iv > 0 ? Math.ceil(iv / 2) + 1 : TRANSIT.defaultWait[leg?.kind] ?? 6;
  return Math.min(TRANSIT.maxWaitMin, Math.max(2, w));
}
const transitIdx = (legs) => legs.map((l, i) => (l.kind === 'walk' ? -1 : i)).filter((i) => i >= 0);

/** 실시간 열차 · 버스 → 탈 수 있는 시각 목록(분, 오늘 0시 기준) */
function liveTimes(rt, leg, nowMin, untilMin) {
  if (!rt) return null;
  if (rt.kind === 'subway' && leg.kind === 'subway' && Array.isArray(rt.trains) && rt.trains.length) {
    const t = rt.trains.map((x) => ({ at: nowMin + x.etaSec / 60, live: true, approx: Boolean(x.approx), dest: x.dest || '' }));
    const head = num(leg.intervalMin) > 0 ? leg.intervalMin : 5; // 받은 열차 뒤로는 배차간격으로 이어 붙인 예상
    while (t.length < 40 && t[t.length - 1].at + head <= untilMin) t.push({ at: t[t.length - 1].at + head, live: false, dest: '' });
    return t;
  }
  if (rt.kind === 'bus' && leg.kind === 'bus' && Array.isArray(rt.buses)) {
    const out = [];
    for (const b of rt.buses) for (const x of busTimes({ etasSec: b.etasSec || [], termMin: b.termMin, msgs: b.msgs }, nowMin, untilMin)) out.push({ at: x.boardMin, live: x.live, no: b.no });
    return out.length ? out.sort((a, b) => a.at - b.at) : null;
  }
  return null;
}

/** 실시간 목록에서 역 · 정류장 도착(arrive) 뒤 탈 수 있는 첫 차 — 지하철은 역 입구 → 승강장 2분 뒤(첫 구간 · 환승 구간 같은 규칙) */
function liveBoard(times, leg, arrive) {
  const need = arrive + (leg.kind === 'subway' ? TRANSIT.platformMin : 0);
  return times.find((x) => x.at >= need - 1e-9) || null;
}

/**
 * 출발 시각 D(분)에 나가면 어떻게 가는지 한 번 따라가 보기.
 * '출발했어요!'(D가 지난 시각)일 때:
 *   - pins[i]: 이미 탔다고 본 구간(탈 시각이 지남) — 그때 계산한 탑승 · 이동 시간을 그대로 씀(실시간 목록에는 지난 차가 없어서)
 *   - 고정값이 없는데 표준 대기로도 이미 탔을 시각이 지난 구간 → 실시간을 쓰지 않음(실시간은 '지금부터 올 차'만 알려 줌)
 *   (D가 지금 이후면 두 경우 모두 생기지 않아 지금까지와 같은 계산)
 * @param {object} [o.pins]  { [구간 번호]: { board, ride, src, vehicle, approx, gate?, byTrip? } }
 * @returns {{ classArriveMin, legs: Array, gate }}
 */
export function simulate(route, D, { cls, nowMin, rt = null, walkTable, untilMin, pins = null, midKinds = MID_LIVE_KINDS }) {
  const legs = route.legs, idx = transitIdx(legs), firstI = idx[0], lastI = idx[idx.length - 1];
  const until = untilMin ?? (D + 300);
  const firstTimes = rt?.first && rt.first.i === firstI ? liveTimes(rt.first, legs[firstI], nowMin, until) : null;
  // v2.6.0 환승 구간 실시간(첫 탑승이 아닌 구간 한 곳 — 켠 종류 midKinds: 지하철 · v2.7.0 버스) — 첫 구간과 같은 방식(liveTimes · liveBoard)
  const midI = rt?.mid && Number.isInteger(rt.mid.i) && transferLegs(route, midKinds).includes(rt.mid.i) ? rt.mid.i : null;
  const midTimes = midI != null ? liveTimes(rt.mid, legs[midI], nowMin, until) : null;
  const finalCands = [];
  if (rt?.final && rt.final.i === lastI && legs[lastI].kind === 'bus') {
    for (const trip of rt.final.trips || []) for (const b of busTimes(trip, nowMin, until)) finalCands.push({ ...b, trip });
    finalCands.sort((a, b) => a.boardMin - b.boardMin);
  }
  const out = [];
  let t = D, gate = null, finalByTrip = false;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.kind === 'walk') {
      if (i > lastI && finalByTrip) continue; // 국민대 정류장 → 정문 도보는 '하차 문 → 강의 건물' 도보로 대신
      const transfer = i > firstI && i < lastI;
      const extra = transfer ? TRANSIT.transferSafetyMin : 0;
      out.push({ i, kind: 'walk', start: t, end: t + leg.min + extra, min: leg.min, safety: extra, transfer });
      t += leg.min + extra;
      continue;
    }
    // 앞 구간과 바로 이어지는 환승(도보 구간 없이 같은 역에서 갈아탐)에도 안전 여유
    if (i !== firstI && legs[i - 1]?.kind !== 'walk') { out.push({ i, kind: 'walk', start: t, end: t + TRANSIT.transferSafetyMin, min: 0, safety: TRANSIT.transferSafetyMin, transfer: true }); t += TRANSIT.transferSafetyMin; }
    const arrive = t;
    const pin = pins?.[i];
    if (pin && Number.isFinite(pin.board) && Number.isFinite(pin.ride) && pin.board <= nowMin + PIN_LOCK_MIN) {
      // 이미 탔다고 본 구간: 그때 계산한 값 그대로(마지막 버스면 하차 문 · 도보 계산도 그때와 같게)
      if (i === lastI && pin.byTrip) { gate = pin.gate || null; finalByTrip = true; }
      out.push({ i, kind: leg.kind, arrive, board: pin.board, end: pin.board + pin.ride, wait: pin.board - arrive, ride: pin.ride, src: pin.src || 'std', approx: Boolean(pin.approx), vehicle: pin.vehicle || (leg.kind === 'bus' ? leg.no : leg.line), pinned: true, ...(i === lastI && pin.byTrip ? { byTrip: true, gate: pin.gate || null } : {}) });
      t = pin.board + pin.ride;
      continue;
    }
    const passed = arrive + stdWait(leg) <= nowMin; // 표준 대기로도 이미 탔을 시각(고정값 없음) → 실시간의 '다음 차'를 붙이지 않음
    let board = null, ride = leg.min, src = 'std', vehicle = leg.kind === 'bus' ? leg.no : leg.line, approx = false, byTrip = false;
    if (!passed && i === lastI && finalCands.length) {
      const c = finalCands.find((x) => x.boardMin >= arrive - 1e-9);
      if (c) { board = c.boardMin; ride = c.trip.inVehicleMin; src = c.live ? 'live' : 'term'; vehicle = c.trip.no; gate = c.trip.gate; finalByTrip = true; byTrip = true; }
    }
    // 첫 구간 · 환승 구간(v2.6.0): 받은 실시간에서 탈 수 있는 첫 차(지하철은 승강장 2분 뒤)
    const times = !passed && board == null ? (i === firstI ? firstTimes : i === midI ? midTimes : null) : null;
    const c = times ? liveBoard(times, leg, arrive) : null;
    if (c) { board = c.at; src = c.live ? 'live' : 'term'; approx = Boolean(c.approx); if (c.no) vehicle = c.no; }
    if (board == null) { board = arrive + stdWait(leg); src = 'std'; }
    out.push({ i, kind: leg.kind, arrive, board, end: board + ride, wait: board - arrive, ride, src, approx, vehicle, ...(byTrip ? { byTrip: true, gate } : {}) });
    t = board + ride;
  }
  const walkIn = walkToBuilding(walkTable, cls?.building, gate || '정문');
  return { classArriveMin: t + walkIn, legs: out, gate: gate || '정문', walkInMin: walkIn };
}

const firstLegOf = (route, sim) => {
  const s = sim.legs.find((l) => l.kind !== 'walk'), leg = route.legs[s.i];
  return { s, leg };
};
/** 첫 탑승 정보: 화면 ① 카드 · 알림 문장용 */
export function firstBoard(route, sim) {
  const { s, leg } = firstLegOf(route, sim);
  const bus = leg.kind === 'bus';
  return {
    kind: leg.kind, no: bus ? s.vehicle || leg.no : leg.line, label: bus ? `${s.vehicle || leg.no}번` : leg.line, color: leg.color, ink: inkOn(leg.color),
    typeLabel: bus ? leg.typeLabel : '지하철', boardMin: s.board, stop: leg.from.name, src: s.src,
  };
}

/**
 * 오늘 첫 수업에 맞춘 환승 경로 추천 — 화면(recommend와 같은 모양)과 서버 알림이 같이 씀
 * @param {object} p
 * @param {object} p.route  parseOdsayPath 결과(저장한 경로)
 * @param {object|null} p.rt  실시간 { first: {i, kind, trains|buses}, final: {i, trips} } — 도착 예정(초)은 nowMin 기준
 * @param {number|null} [p.departedMin]  v2.2 '출발했어요!'를 누른 시각(분) — 있으면 '지금 출발'로 다시 계산하지 않고 그 시각에 나갔다고 보고 끝까지
 *   (수업이 시작된 뒤에도 도착 예정 시각까지는 'ok'로 안내)
 * @param {object|null} [p.pins]  v2.2 이미 탔다고 고정한 구간(lockPins) — simulate 참고
 * @param {string[]} [p.midKinds]  v2.6.0 실시간(rt.mid)을 쓰는 환승 구간 종류 — 기본 MID_LIVE_KINDS(지하철 · 버스)
 * @returns {{ state, mode:'transit', cls, pick?, status?, slackMin?, departNow?, departed?, personalMin?, liveFirst?, liveFinal? }}
 */
export function planTransit({ route, cls, nowMin, rt = null, walkTable, marginMin = DEFAULTS.marginMin, personalOffsetMin = 0, departedMin = null, pins = null, midKinds = MID_LIVE_KINDS }) {
  if (!cls) return { state: 'no-class', mode: 'transit' };
  const start = toMin(cls.start);
  const departed = Number.isFinite(departedMin);
  if (nowMin >= start && !departed) return { state: 'started', mode: 'transit', cls };
  if (!route?.legs?.length) return { state: nowMin >= start ? 'started' : 'no-trip', mode: 'transit', cls };
  const personal = appliedOffset(personalOffsetMin);
  // 출발한 뒤에는 수업 시작이 지나도 따라가므로 탈 수 있는 차 목록을 지금부터 2시간까지
  // v2.6.0 환승 지하철 실시간(rt.mid)은 '출발했어요!' 뒤에만 씀(출발 취소 직후 다음 갱신 전까지 남은 값은 쓰지 않음)
  const rtUse = !departed && rt?.mid ? { ...rt, mid: null } : rt;
  const ctx = { cls, nowMin, rt: rtUse, walkTable, midKinds, untilMin: departed ? Math.max(start + 60, nowMin + 120) : start + 60, ...(departed && pins ? { pins } : {}) };
  const target = start - marginMin;
  const ok = (D) => simulate(route, D, ctx).classArriveMin + personal <= target + 1e-9;
  let D;
  if (departed) D = departedMin; // 누른 시각에 나갔다고 봄(지난 시각이어도) — 다시 '지금 출발'로 밀지 않음
  else if (!ok(nowMin)) D = nowMin; // 지금 나가도 빠듯 · 늦음 → 지금 출발
  else {
    let lo = nowMin, hi = start;
    while (hi - lo > 0.02) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
    // 분 단위로 내림(보수적). 경계가 딱 정수일 때 이분 탐색이 그 바로 아래에서 멈추는 것을 바로잡음
    let cand = Math.floor(lo + 0.05);
    if (cand > lo && !ok(cand)) cand = Math.floor(lo);
    D = Math.max(nowMin, cand);
  }
  const sim = simulate(route, D, ctx);
  const arrive = sim.classArriveMin + personal;
  // 출발한 날 수업이 시작된 뒤: 도착 예정 시각이 지나면 지금처럼 '수업이 시작됐어요'
  if (nowMin >= start && arrive <= nowMin) return { state: 'started', mode: 'transit', cls };
  const slackMin = start - arrive;
  const status = slackMin >= marginMin ? 'relaxed' : slackMin >= 0 ? 'tight' : 'late';
  const fb = firstBoard(route, sim);
  return {
    state: 'ok', mode: 'transit', cls, classStartMin: start, status, slackMin, personalMin: personal,
    departNow: !departed && D <= nowMin + 0.5,
    ...(departed ? { departed: true, departedMin: D } : {}),
    pick: {
      departMin: D, boardMin: fb.boardMin, classArriveMin: arrive, live: fb.src === 'live',
      trip: { no: fb.no, label: fb.label, type: fb.typeLabel, color: fb.color, ink: fb.ink, kind: fb.kind, stop: fb.stop },
      legs: sim.legs, gate: sim.gate, walkInMin: sim.walkInMin,
    },
    liveFirst: sim.legs.some((l) => l.kind !== 'walk' && l.src === 'live' && l.i === legEnds(route).first),
    liveFinal: sim.legs.some((l) => l.kind !== 'walk' && l.src !== 'std' && l.i === legEnds(route).last),
  };
}

/* ── v2.2 '출발했어요!' — 누른 시각에 나갔다고 보고 끝까지(사용자 위치는 모름 → 지남 · 타는 중은 예상) ── */
const r3 = (v) => Math.round(v * 1000) / 1000;
/** 저장한 경로를 알아보는 표(출발 기록이 다른 경로에 붙지 않게) — 화면 · 서버가 같은 값 */
export function routeKey(route) {
  const legs = route?.legs || [];
  const parts = legs.filter((l) => l.kind !== 'walk').map((l) => `${l.kind === 'bus' ? str(l.no) : str(l.line)}@${str(l.from?.name)}`);
  return parts.length ? `${parts.join('>')}#${legs.length}` : '';
}
/** [출발했어요!]를 보여 줄 때: 환승 계산이 'ok'이고 아직 안 눌렀고, 추천 출발 1시간 전부터(지금 출발이면 바로) — 수업 시작 뒤에는 'started'라 안 보임 */
export function canDepart(plan, nowMin) {
  return plan?.state === 'ok' && plan.mode === 'transit' && !plan.departed && Boolean(plan.pick)
    && (plan.departNow || nowMin >= plan.pick.departMin - TRANSIT.departBeforeMin);
}
/**
 * 누른 뒤 화면용: 탈 구간마다 지남(done) · 타는 중(riding) · 다음(next) · 그 뒤(later) — 누른 시각으로 계산한 예상
 * @returns {{ byLeg: Object<number, 'done'|'riding'|'next'|'later'>, next: object|null, last: object|null } | null}
 */
export function departProgress(plan, nowMin) {
  if (plan?.state !== 'ok' || !plan.departed) return null;
  const legs = plan.pick.legs.filter((l) => l.kind !== 'walk');
  const byLeg = {};
  let next = null;
  for (const s of legs) {
    const st = s.end <= nowMin ? 'done' : s.board <= nowMin ? 'riding' : next ? 'later' : 'next';
    if (st === 'next') next = s;
    byLeg[s.i] = st;
  }
  return { byLeg, next, last: legs[legs.length - 1] || null };
}
/* ── v2.6.0 환승 구간 실시간('출발했어요!' 뒤 · 탈 때 ±15분 · 한 번에 한 곳) ──
 * 구간 종류와 상관없는 부분(어느 구간 · 기준 시각 · 창 · 다시 계산)은 여기, 받아 오기 · 하루 몫은 서버의 종류별 받아 오기(backend midLive.js).
 * v2.6.0 지하철 · v2.7.0 중간 환승 버스(서울시 · 경기도 정류장 — 마지막 국민대행 버스는 rt.final이 맡아 빠짐)
 *   (버스는 승강장 시간 없이 정류장 도착 뒤 첫 차 · 기준 시각은 같은 규칙 — 도착 예상 + 표준 기다림(배차 절반 + 1분)) */
/** 실시간을 붙이는 환승 구간 종류(v2.6.0 지하철 · v2.7.0 버스) */
export const MID_LIVE_KINDS = Object.freeze(['subway', 'bus']);
/**
 * 환승 구간(첫 탑승이 아닌 탈 것) 번호 — 마지막 국민대행 버스는 rt.final이 맡으므로 뺌(마지막 구간이 지하철이면 포함)
 * @param {string[]} [kinds]  고를 종류(기본 MID_LIVE_KINDS)
 */
export function transferLegs(route, kinds = MID_LIVE_KINDS) {
  const legs = route?.legs || [], idx = transitIdx(legs), last = idx[idx.length - 1];
  return idx.slice(1).filter((i) => !(i === last && legs[i].kind === 'bus') && kinds.includes(legs[i].kind));
}
/** 환승 지하철(첫 탑승이 아닌 지하철 — 마지막 구간이 지하철이어도 포함) */
export const transferSubways = (route) => transferLegs(route, ['subway']);
/**
 * (화면) 서버에 알려 줄 '다음 탈 환승 구간': '출발했어요!' 뒤 다음 탈 구간(departProgress의 next)이 켠 종류의 환승 구간일 때만
 *   at = 그 역 · 정류장 도착 예상(분) — 이미 탄 구간 고정값 · 첫 구간 실시간이 들어간 이 기기 계산. 그 구간 자신의 실시간과는 무관(창이 스스로 밀리지 않게)
 * @returns {{ i: number, at: number } | null}  종류는 보내지 않음(서버가 저장한 경로에서 정함)
 */
export function midHint(plan, route, nowMin, kinds = MID_LIVE_KINDS) {
  const nx = departProgress(plan, nowMin)?.next;
  if (!nx || !Number.isFinite(nx.arrive)) return null;
  if (!transferLegs(route, kinds).includes(nx.i)) return null;
  return { i: nx.i, at: Math.round(nx.arrive * 10) / 10 };
}
/** 구간 종류별 '실시간을 부를 수 있는 노선인지' — 지하철: 허용 목록 · 비상 끄기. 그 밖의 종류는 서버 받아 오기가 정함 */
function midSupport(leg, offLines) {
  return leg?.kind === 'subway' ? liveSupport(leg, offLines) : { ok: true };
}
/**
 * (서버 · 체험판) 환승 구간 실시간을 부를지: 출발 기록 · 기기가 알려 준 구간(켠 종류) · 실시간 허용 목록 · 예정 탑승 ±15분
 *   기준 T = 기기가 알려 준 도착 예상 + 표준 기다림. 서버 표준값 S(출발 기록 시각 기준 · 실시간 없음)의 −15 ~ +30분 밖이면 S
 * @param {object} stdPlan planTransit({ … departedMin })(실시간 없음)  @param {{ i, at }|null} hint
 * @param {{ offLines?: Set|null, kinds?: string[] }} [o]  offLines 지하철 비상 끄기 · kinds 켠 종류(기본 MID_LIVE_KINDS)
 * @returns {{ ok: boolean, reason?: 'no-hint'|'not-departed'|'not-transfer'|'line'|'off'|'not-yet'|'passed', i?, kind?, T?, S?, clamped?: boolean }}
 */
export function midCheck(route, stdPlan, hint, nowMin, { offLines = null, kinds = MID_LIVE_KINDS } = {}) {
  const i = Number(hint?.i), at = Number(hint?.at);
  if (!hint || !Number.isInteger(i) || !Number.isFinite(at)) return { ok: false, reason: 'no-hint' };
  if (stdPlan?.state !== 'ok' || !stdPlan.departed) return { ok: false, reason: 'not-departed', i };
  const legs = route?.legs || [];
  const s = transferLegs(route, kinds).includes(i) ? stdPlan.pick.legs.find((l) => l.i === i && l.kind !== 'walk') : null;
  if (!s) return { ok: false, reason: 'not-transfer', i };
  const kind = legs[i].kind;
  const sup = midSupport(legs[i], offLines);
  if (!sup.ok) return { ok: false, reason: sup.reason, i, kind };
  const S = s.board;
  let T = at + stdWait(legs[i]);
  const clamped = !(T >= S - TRANSIT.midHintEarlyMin && T <= S + TRANSIT.midHintLateMin);
  if (clamped) T = S;
  const w = { i, kind, T: Math.round(T * 10) / 10, S: Math.round(S * 10) / 10, clamped };
  if (nowMin < T - TRANSIT.midWindowMin) return { ok: false, reason: 'not-yet', ...w };
  if (nowMin > T + TRANSIT.midWindowMin) return { ok: false, reason: 'passed', ...w };
  return { ok: true, ...w };
}

/**
 * 누른 뒤 '이미 탔음'으로 고정할 구간: 탈 시각이 30초 안으로 다가왔거나 지난 구간을 그때 값으로(이미 고정한 구간은 그대로).
 * 화면이 이 값을 기기에 두었다가 planTransit({ pins })로 다시 넘김. 바뀐 게 없으면 prev를 그대로 돌려줌
 */
export function lockPins(plan, nowMin, prev = null) {
  if (plan?.state !== 'ok' || !plan.departed) return prev;
  let out = prev;
  for (const s of plan.pick.legs) {
    if (s.kind === 'walk' || out?.[s.i] || s.board > nowMin + PIN_LOCK_MIN) continue;
    out = { ...(out || {}), [s.i]: { board: r3(s.board), ride: r3(s.ride), src: s.src, vehicle: s.vehicle, approx: Boolean(s.approx), ...(s.byTrip ? { byTrip: true, gate: s.gate || null } : {}) } };
  }
  return out;
}

/**
 * 카드 위쪽 요약(경로 고르기 목록 · 홈 카드): 총 소요(기다림 · 환승 여유 포함), 수단별 막대, 환승 횟수 · 요금
 * plan을 주면 그 계산(실시간 포함)으로, 없으면 표준 대기 시간으로
 */
export function routeSummary(route, plan = null) {
  const legs = route.legs;
  const sim = plan?.pick?.legs || simulate(route, 0, { cls: null, nowMin: 0, walkTable: {} }).legs;
  const segments = [];
  for (const s of sim) {
    const leg = legs[s.i];
    if (s.kind === 'walk') { if (s.min > 0) segments.push({ kind: 'walk', min: s.min, color: MODE_COLOR.walk, label: `도보 ${Math.round(s.min)}분` }); continue; }
    segments.push({ kind: leg.kind, min: s.ride, color: leg.kind === 'subway' ? MODE_COLOR.subway : leg.color, label: leg.kind === 'bus' ? `${s.vehicle || leg.no}번 버스` : leg.line });
  }
  const startMin = plan?.pick ? plan.pick.departMin : 0;
  const endMin = plan?.pick ? plan.pick.classArriveMin : sim[sim.length - 1].end;
  const total = Math.round(endMin - startMin);
  return { totalMin: total, segments, transfers: route.transfers, payment: route.payment, startMin: plan?.pick ? startMin : null, endMin: plan?.pick ? endMin : null };
}

/** '1시간 5분' · '48분' */
export function durationText(min) {
  const m = Math.max(0, Math.round(min)), h = Math.floor(m / 60);
  return h ? `${h}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${m}분`;
}
export const hhmm = (m) => toHHMM(Math.floor(m + 1e-9));

/** 실시간을 써야 하는 때인지(지하철 호출 아끼기): 표준 계산 출발 30분 전 ~ 출발 20분 뒤 */
export function wantsLive(stdPlan, nowMin) {
  if (stdPlan?.state !== 'ok') return false;
  const d = stdPlan.pick.departMin;
  return nowMin >= d - TRANSIT.liveBeforeMin && nowMin <= d + TRANSIT.liveAfterMin;
}

/** 지하철 구간 이름(실시간 조회용 역 이름: '역' · 괄호 뺌) */
export const subwayStationName = (leg) => stationKey(leg?.from?.name);
/** 경로의 첫 · 마지막 탑승 구간 번호 */
export function legEnds(route) { const idx = transitIdx(route?.legs || []); return { first: idx[0], last: idx[idx.length - 1] }; }

/* ── v2.1 환승 경로 '왜 늦나요?'(직행과 같은 기준 + 첫 지하철 간격) ── */
const stationLabel = (name) => { const n = str(name); return n && !/역$/.test(n) ? `${n}역` : n; };

/**
 * 계산이 고른 마지막 국민대행 버스(서울시 실시간 trips 중 실제로 탈 차) — 서버가 붙인 explain · delayMin · congestion을 그대로 씀.
 * 마지막 구간이 버스가 아니거나 실시간이 없으면(표준 대기로 계산) null
 */
export function finalTripOf(route, plan, rt) {
  const { last } = legEnds(route);
  if (plan?.state !== 'ok' || route?.legs?.[last]?.kind !== 'bus' || rt?.final?.i !== last) return null;
  const s = plan.pick.legs.find((l) => l.i === last && l.kind !== 'walk');
  if (!s || s.src === 'std') return null;
  return (rt.final.trips || []).find((t) => t.no === s.vehicle) || null;
}

/**
 * 첫 지하철: 내가 탈 열차 바로 앞의 간격(앞 열차 → 내 열차, 앞 열차가 없으면 지금 → 내 열차)이
 * ODsay 배차간격보다 TRANSIT.gapExtraMin분 이상 길면 그 사실(서울시 실시간 기준). 아니면 null.
 * 도착 문구로 어림한 열차(approx)는 시각이 정확하지 않아 쓰지 않음. AI 없이 고정 문장(기본 안내)
 * @returns {{ line, station, gapMin, intervalMin, extraMin, sample, text } | null}
 */
export function subwayGap(route, plan, rt, nowMin) {
  const { first } = legEnds(route);
  const leg = route?.legs?.[first], f = rt?.first;
  if (plan?.state !== 'ok' || leg?.kind !== 'subway' || f?.kind !== 'subway' || f.i !== first || !['seoul', 'sample'].includes(f.source)) return null;
  const s = plan.pick.legs.find((l) => l.i === first && l.kind !== 'walk');
  const iv = num(leg.intervalMin);
  if (!s || s.src !== 'live' || s.approx || !(iv > 0) || !Number.isFinite(nowMin)) return null;
  const ats = (f.trains || []).filter((x) => !x.approx && Number.isFinite(x.etaSec)).map((x) => nowMin + x.etaSec / 60);
  const prev = Math.max(nowMin, ...ats.filter((a) => a < s.board - 0.05));
  const gap = s.board - prev, extraMin = Math.round(gap - iv);
  if (extraMin < TRANSIT.gapExtraMin) return null;
  const station = stationLabel(leg.from?.name);
  return { line: leg.line, station, gapMin: Math.round(gap), intervalMin: iv, extraMin, sample: f.source === 'sample', text: `${station} ${leg.line} 열차 간격이 평소보다 길어요.` };
}
