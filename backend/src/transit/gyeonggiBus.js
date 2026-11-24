// v2.4.0 경기도 버스 G1 — 공공데이터포털 경기도 버스 API(GBIS v2) 연결 확인 도구
//   경기도_정류소 조회 · 경기도_버스도착정보 조회 · 경기도_버스노선 조회(같은 일반 인증키)를 고정된 공개 입력으로 한 번씩 불러
//   키가 통하는지 · 응답 형식(머리말 · 목록 이름 · 필드 이름)이 안내와 같은지만 확인합니다. 경로 계산 · 화면에는 아직 쓰지 않아요(G2부터).
//   https://apis.data.go.kr/6410000/{서비스}/v2/{기능}?serviceKey=…&format=json&…
//   · 키 GYEONGGI_BUS_API_KEY(공공데이터포털 일반 인증키 — Decoding 권장, Encoding(% 포함)도 그대로): 서버 전용, 응답 · 로그 · health에 안 나옴
//   · 서비스별 하루 상한 GYEONGGI_BUS_DAILY_CAP(비우면 900, 최대 1,000 — 개발계정은 서비스마다 하루 1,000건) — 외부 DB 날짜별 카운터
//   · GYEONGGI_BUS_CACHE_SEC(비우면 30, 10~300): v2.5.0 G2부터 정류장별 도착 정보를 이만큼 보관해 사용자끼리 나눠 씀
//   · 확인 도구(/api/gyeonggi/test): 한 번에 최대 5건(정류소 3 · 도착 1 · 노선 1, v2.5.1: ⑤가 실패하면 판단 확인에 이름 검색 1건 더) · 결과 10분 보관 · 하루 3번 ·
//     키가 아예 등록되지 않았으면 첫 호출에서 멈춤 · 사용자 경로 · 위치와 무관(입력은 고정 이름 '수원역'과 그 응답에서 고른 값뿐)
// v2.5.0 G2 — 저장한 경로의 첫 탑승이 버스이고(마지막 국민대행 버스가 아님) 그 정류장이 '경기도 정류장'으로 확인될 때만 경기도 도착 정보를 씀.
//   판단 순서(하나라도 확실하지 않으면 쓰지 않고 지금처럼 서울시로):
//     ① 경기도 정류소 중 정류장 번호(5자리)가 같고 100m 안인 곳 — 주변 정류소(500m) → 없으면 이름 검색. 번호가 없으면 이름이 같고 30m 안인 곳이 하나뿐일 때만
//     ② 그 정류장의 지역이 서울 · 인천이 아님  ③ 그 정류장을 지나는 노선에 경로의 버스 번호가 있고 방향이 하나(같은 노선이 두 번 지나면 안 씀)
//   판단 결과는 서버 메모리에만 보관(정류장 기준 · 사용자 번호 없음 · 외부 DB에 저장 안 함): 쓸 수 있음 · 서울 · 인천 30일, 못 찾음 등 1일, 실패 10분.
//   판단 결과가 아직 없으면 이번 요청은 지금처럼 서울시로 계산하고 판단은 뒤에서(다음 갱신부터 경기도) — 응답이 느려지지 않게.
//   도착 정보: 출발 30분 전 ~ 20분 뒤에만(transitLive가 판단) · 정류장마다 GYEONGGI_BUS_CACHE_SEC(30초) 동안 사용자끼리 나눠 씀 ·
//     초 단위 예측(predictTimeSec)을 쓰고 분만 있으면 30초 일찍 온다고 봄 · 회차지 대기(WAIT) · 운행 종료(STOP)는 쓰지 않음 · 받은 뒤 흐른 시간은 뺌
//   경기도 API에는 첫 버스 정류장의 좌표 · 이름 · 번호와 노선 · 정류장 ID만 보냄(사용자 번호 · 출발지 GPS는 보내지 않음)
// v2.5.1 주변 정류소(getBusStationAroundListv2)가 시간 초과 · 연결 실패 · 5xx · 형식 다름처럼 '주변 정류소만의 문제'로 실패하면 이름 검색으로 이어서 판단.
//   키 · 승인 · 한도 문제(auth · denied · quota · rate · cap)면 이름 검색도 같은 '정류소 조회' 서비스라 부르지 않고 바로 실패(호출 아끼기).
//   이름 검색 목록에서 고를 때는 번호 + 100m에 이름까지 같아야 함(주변 목록 없이는 '같은 번호의 다른 정류장이 근처에 있는지' 확인할 수 없어서 이름으로 메움).
//   주변 정류소가 실패하고 이름 검색에서도 못 찾으면 '못 찾음(1일)'이 아니라 '실패'로 두고 다시 판단 — 실패가 이어지면 10 → 20 → 40 → 60분 간격.
//   기다리는 시간(경로 계산 4초 · 확인 도구 5초)과 같은 판단 안에서 주변 정류소를 다시 부르지 않는 것은 그대로
import { seoulParts } from '../../../shared/time.js';
import { distanceM } from '../../../shared/transitPlan.js';

const BASE = 'https://apis.data.go.kr/6410000';
export const GG_SERVICES = Object.freeze({
  station: Object.freeze({ path: 'busstationservice/v2', name: '경기도_정류소 조회' }),
  arrival: Object.freeze({ path: 'busarrivalservice/v2', name: '경기도_버스도착정보 조회' }),
  route: Object.freeze({ path: 'busrouteservice/v2', name: '경기도_버스노선 조회' }),
});
// 고정된 시험 입력: 이름 검색은 '수원역'. 검색 결과가 없을 때만 공식 안내의 예제 값(정류소 200000177 · 노선 200000037)을 씀
export const GG_TEST = Object.freeze({ keyword: '수원역', fallbackStationId: '200000177', fallbackRouteId: '200000037', fallbackX: '127.0284667', fallbackY: '37.49545' });
export const GG_TEST_MAX_PER_DAY = 3;
const TEST_TTL_MS = 10 * 60_000;
const CNT = (svc, d) => `kubusai:gg:calls:${svc}:${d}`;
const TEST_CNT = (d) => `kubusai:gg:test:${d}`;
const NOTE = '고정된 공개 입력(정류장 이름 \'수원역\')으로 경기도 버스 API 3종을 시험한 결과예요. 사용자 경로 · 위치와 무관하고 인증키는 나오지 않아요. 같은 결과는 10분 동안 보관하고 하루 3번까지 새로 시험해요. selfJudge는 고른 정류장으로 G2 판단 순서를 다시 해 본 결과예요(⑤ 주변 정류소가 실패하면 실제 판단처럼 이름 검색으로 — 이때만 1건 더).';

/* ── 응답 해석(서버 · 테스트가 같은 코드) ── */
const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const keysOf = (o) => (isObj(o) ? Object.keys(o).filter((k) => SAFE_KEY.test(k)).slice(0, 30) : null);
const cut = (v, n = 40) => str(v).slice(0, n);
// 공공데이터포털 게이트웨이 오류(대개 XML) — 이름으로 찾음(번호는 안내 표 기준: 30 미등록 키 · 20 접근 거부 · 22 하루 한도 · 23 초당 한도 · 12 서비스 없음 · 10 잘못된 요청)
const GATEWAY = [
  [/SERVICE_KEY_IS_NOT_REGISTERED_ERROR|SERVICE_KEY_IS_NULL|DEADLINE_HAS_EXPIRED_ERROR|UNREGISTERED_IP_ERROR|BLACKLIST_IP_ACCESS_ERROR/, 'auth'],
  [/SERVICE_ACCESS_DENIED_ERROR|PERMISSION_DENIED/, 'denied'],
  [/LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR/, 'rate'],
  [/LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR/, 'quota'],
  [/NO_OPENAPI_SERVICE_ERROR/, 'endpoint'],
  [/INVALID_REQUEST_PARAMETER_ERROR/, 'param'],
  [/SERVICETIMEOUT_ERROR|HTTP_ERROR|APPLICATION_ERROR/, 'error'],
];
// 응답 목록 이름(안내 기준) — 없으면 본문에서 처음 나오는 객체 목록
const LISTS = ['busArrivalList', 'busArrivalItem', 'busStationList', 'busStationAroundList', 'busStationViaRouteList', 'busRouteList', 'busRouteStationList', 'busRouteInfoItem', 'busLocationList'];
const codeStatus = (c) => (c === 0 ? 'ok' : c === 4 ? 'nodata' : c === 2 ? 'param' : c === 1 ? 'error' : 'api');

function findList(body) {
  if (!isObj(body)) return { key: null, items: [], single: false };
  for (const k of LISTS) {
    if (!own(body, k)) continue;
    const v = body[k];
    if (Array.isArray(v)) return { key: k, items: v.filter(isObj), single: false };
    if (isObj(v)) return { key: k, items: [v], single: true }; // 한 건이면 목록 대신 객체로 오는 경우
  }
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (Array.isArray(v) && v.some(isObj)) return { key: SAFE_KEY.test(k) ? k : '(이름 없음)', items: v.filter(isObj), single: false };
  }
  return { key: null, items: [], single: false };
}

/**
 * 경기도 버스 API 응답(글자) → { status, code, message, items, shape }
 *   status: ok · nodata(결과 없음, 키는 통함) · auth(키 미등록 · 만료) · denied(이 서비스 승인 안 됨) · quota(하루 한도) · rate(초당 한도) ·
 *           endpoint(주소 없음) · param(요청 값) · error(서버 · 연결) · api(처음 보는 결과 코드) · format(형식이 다름)
 *   shape: 머리말 · 본문 · 목록 이름(값 없이 이름만) — 실제 응답 형식 확인용
 */
export function parseGbis(text, httpStatus = 200) {
  const raw = String(text ?? '');
  for (const [re, status] of GATEWAY) { const m = re.exec(raw); if (m) return { status, code: m[0], message: m[0], items: [], shape: { gateway: true } }; }
  const hs = Number(httpStatus) || 200;
  if (hs === 401 || hs === 403) return { status: 'auth', code: `HTTP ${hs}`, message: `HTTP ${hs}`, items: [], shape: null };
  if (hs === 429) return { status: 'rate', code: 'HTTP 429', message: 'HTTP 429', items: [], shape: null };
  if (hs === 404) return { status: 'endpoint', code: 'HTTP 404', message: 'HTTP 404', items: [], shape: null };
  if (hs < 200 || hs >= 300) return { status: 'error', code: `HTTP ${hs}`, message: `HTTP ${hs}`, items: [], shape: null };
  let j = null;
  try { j = JSON.parse(raw); } catch { /* XML · 글자 */ }
  if (!isObj(j)) {
    const c = /<resultCode>\s*(\d+)\s*<\/resultCode>/.exec(raw);
    if (c) {
      const m = /<resultMessage>([^<]{0,120})<\/resultMessage>/.exec(raw);
      return { status: codeStatus(Number(c[1])), code: c[1], message: str(m?.[1]), items: [], shape: { xml: true } };
    }
    return { status: 'format', code: null, message: cut(raw.replace(/\s+/g, ' '), 80), items: [], shape: { json: false } };
  }
  const root = isObj(j.response) ? j.response : j;
  const head = isObj(root.msgHeader) ? root.msgHeader : isObj(root.header) ? root.header : root;
  const body = isObj(root.msgBody) ? root.msgBody : isObj(root.body) ? root.body : root;
  const code = num(head.resultCode);
  const { key, items, single } = findList(body);
  const shape = {
    top: keysOf(j), ...(root !== j ? { response: keysOf(root) } : {}),
    header: head !== root ? keysOf(head) : null, body: body !== root ? keysOf(body) : null, list: key, single,
  };
  const status = code == null ? (items.length ? 'ok' : 'format') : codeStatus(code);
  return { status, code: code == null ? null : String(code), message: cut(head.resultMessage ?? head.resultMsg, 80), items, shape };
}

// 확인 결과에 싣는 값(공개 버스 정보 중 형식 확인에 필요한 것만 — 차량 번호 · 차량 ID는 싣지 않음)
const SAMPLE_FIELDS = {
  getBusStationListv2: ['stationId', 'stationName', 'mobileNo', 'regionName', 'x', 'y', 'centerYn', 'districtCd'],
  getBusStationAroundListv2: ['stationId', 'stationName', 'mobileNo', 'regionName', 'x', 'y', 'distance'],
  getBusStationViaRouteListv2: ['routeId', 'routeName', 'routeTypeCd', 'routeTypeName', 'staOrder', 'routeDestId', 'routeDestName', 'regionName'],
  getBusArrivalListv2: ['routeId', 'routeName', 'routeTypeCd', 'staOrder', 'routeDestName', 'flag', 'predictTime1', 'predictTimeSec1', 'locationNo1',
    'stationNm1', 'remainSeatCnt1', 'crowded1', 'stateCd1', 'lowPlate1', 'taglessCd1', 'predictTime2', 'predictTimeSec2', 'locationNo2', 'turnSeq'],
  getBusRouteStationListv2: ['stationSeq', 'stationId', 'stationName', 'mobileNo', 'turnYn', 'turnSeq', 'districtCd', 'adminName', 'regionName', 'x', 'y', 'centerYn'],
};
const sampleOf = (op, item) => {
  if (!isObj(item)) return null;
  const out = {};
  for (const f of SAMPLE_FIELDS[op] || []) {
    if (!own(item, f)) continue;
    const v = item[f];
    out[f] = typeof v === 'number' || typeof v === 'boolean' || v == null ? v : typeof v === 'string' ? cut(v) : `(${Array.isArray(v) ? 'array' : typeof v})`;
  }
  return out;
};
const fieldsOf = (items) => (items.length ? Object.keys(items[0]).filter((k) => SAFE_KEY.test(k)).sort().slice(0, 60) : []);
const countBy = (items, f) => Object.fromEntries([...items.reduce((m, x) => { const k = cut(x?.[f], 12) || '(빈 칸)'; return m.set(k, (m.get(k) || 0) + 1); }, new Map())]);

const VERDICT = {
  ok: '작동', nodata: '작동(결과 없음 — 심야이거나 지금 그 정류장에 오는 버스가 없을 수 있어요)',
  auth: '키가 아직 통하지 않아요(공공데이터포털에 키가 등록 · 전파되기 전일 수 있어요 — 몇 시간 뒤 다시 열어 주세요)',
  denied: '이 서비스의 활용신청 · 승인 상태를 공공데이터포털 마이페이지에서 확인해 주세요',
  quota: '오늘 공공데이터포털 하루 한도를 넘었어요(자정에 초기화)', rate: '짧은 시간에 너무 많이 불렀다고 거절됐어요(잠시 뒤 다시)',
  cap: '오늘 우리 서버 상한(GYEONGGI_BUS_DAILY_CAP)에 닿았어요', endpoint: '주소(서비스 · 기능 이름)가 달라요 — 확인 필요',
  param: '요청 값이 맞지 않는다고 해요 — 확인 필요', format: '응답 형식이 예상과 달라요 — 결과의 shape를 그대로 보내 주세요',
  api: '처음 보는 결과 코드예요 — 확인 필요', error: '공공데이터포털 · 경기도 서버 오류이거나 연결하지 못했어요(잠시 뒤 다시)',
  skipped: '앞 단계가 안 돼서 부르지 않았어요',
};
const RANK = ['ok', 'nodata'];

/* ── v2.5.0 G2 판단 도우미 ── */
const MIN_MS = 60_000, DAY_MS = 86_400_000;
// 판단 결과 보관 시간: 쓸 수 있음 · 서울 · 인천은 30일(정류장은 잘 안 바뀜), 못 찾음 · 애매함 등은 1일, 실패는 10분(다시 시도)
export const JUDGE_TTL = Object.freeze({ usable: 30 * DAY_MS, seoul: 30 * DAY_MS, incheon: 30 * DAY_MS, notFound: DAY_MS, ambiguous: DAY_MS, noRegion: DAY_MS, noRoute: DAY_MS, twoWay: DAY_MS, badInput: DAY_MS, failed: 10 * MIN_MS });
const JUDGE_KINDS = Object.keys(JUDGE_TTL);
/** v2.5.1 실패가 이어질 때 다시 판단할 때까지: 1번째 10분 → 20분 → 40분 → 그 뒤로 60분(다른 결과가 나오면 처음부터) */
export const failTtl = (fails) => Math.min(JUDGE_TTL.failed * 2 ** Math.max(0, (Number(fails) || 1) - 1), 60 * MIN_MS);
// v2.5.1 주변 정류소가 이 이유로 실패하면 이름 검색도 부르지 않음(같은 '정류소 조회' 서비스 — 키 미등록 · 승인 안 됨 · 하루/초당 한도 · 우리 상한)
const NO_FALLBACK = Object.freeze(['auth', 'denied', 'quota', 'rate', 'cap']);
/** 정류장 번호 5자리('03-026' · 3026(숫자) → '03026'), 아니면 '' */
export const digits5 = (v) => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 100000) return String(v).padStart(5, '0');
  const d = str(v).replace(/\D/g, '');
  return /^\d{5}$/.test(d) ? d : '';
};
const normName = (s) => str(s).replace(/\(.*?\)/g, '').replace(/\s+/g, '').toLowerCase();
const nameParts = (s) => normName(s).split('.').filter(Boolean); // 경기도 이름은 '고등동사거리.고등동행정복지센터.…'처럼 점으로 여러 이름
/** 이름이 같은지: 점으로 나눈 이름 중 하나라도 똑같으면(괄호 · 띄어쓰기는 빼고) */
export const sameStopName = (a, b) => { const pa = nameParts(a), pb = nameParts(b); return pa.length > 0 && pb.length > 0 && pa.some((x) => pb.includes(x)); };
/** 버스 번호 비교용(1007 숫자 · '1007' · 'm7731' → 'M7731') */
export const busNo = (v) => str(v).replace(/\s+/g, '').toUpperCase();
const NEAR_BY_NUMBER_M = 100, NEAR_BY_NAME_M = 30;

/**
 * 후보 정류소 중 하나 고르기 — 번호가 있으면 '번호가 같고 100m 안', 없으면 '이름이 같고 30m 안'. 둘 이상이면 애매함
 *   requireName(v2.5.1 이름 검색 목록): 번호가 있어도 이름까지 같아야(점으로 나눈 이름 중 하나가 똑같음)
 * @returns {{ station, id, d, by } | { ambiguous: true } | null}
 */
export function chooseStop(items, { ars, name, lat, lon }, { requireName = false } = {}) {
  const cands = [];
  for (const s of Array.isArray(items) ? items : []) {
    const id = str(s?.stationId);
    if (!/^\d{5,12}$/.test(id)) continue;
    const sx = num(s.x), sy = num(s.y);
    const d = sx != null && sy != null ? distanceM({ x: lon, y: lat }, { x: sx, y: sy }) : num(s.distance);
    if (d == null || !Number.isFinite(d)) continue;
    cands.push({ s, id, d });
  }
  const hits = ars
    ? cands.filter((c) => digits5(c.s.mobileNo) === ars && c.d <= NEAR_BY_NUMBER_M && (!requireName || sameStopName(c.s.stationName, name)))
    : cands.filter((c) => c.d <= NEAR_BY_NAME_M && sameStopName(c.s.stationName, name));
  const ids = [...new Set(hits.map((c) => c.id))];
  if (ids.length > 1) return { ambiguous: true };
  if (!ids.length) return null;
  const best = hits.sort((a, b) => a.d - b.d)[0];
  return { station: best.s, id: best.id, d: Math.round(best.d), by: ars ? 'number' : 'name' };
}
/** 저장한 경로의 버스 구간 → 판단에 쓰는 값(정류장 이름 · 좌표 · 번호 · 버스 번호) */
function legInput(leg) {
  const name = str(leg?.from?.name), lat = num(leg?.from?.y), lon = num(leg?.from?.x), ars = digits5(leg?.from?.arsId);
  const buses = [...new Set((Array.isArray(leg?.buses) && leg.buses.length ? leg.buses : [leg?.no]).map(busNo).filter(Boolean))].slice(0, 6);
  const ok = lat != null && lon != null && lat >= 33 && lat <= 39 && lon >= 124 && lon <= 132 && buses.length > 0 && (ars || name);
  return { name, lat, lon, ars, buses, ok: Boolean(ok), key: ok ? `${ars || '-'}|${normName(name)}|${lat.toFixed(4)},${lon.toFixed(4)}|${buses.join(',')}` : null };
}
/** 도착 예측(초) — 초 단위가 있으면 그대로, 분만 있으면 30초 일찍 온다고 봄(놓치지 않게), 없으면 null */
const etaOf = (item, k) => {
  const sec = num(item?.[`predictTimeSec${k}`]);
  if (sec != null && sec >= 0) return sec;
  const min = num(item?.[`predictTime${k}`]);
  return min != null && min >= 0 ? Math.max(0, min * 60 - 30) : null;
};

export function createGyeonggiBusService({ env = process.env, kv = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = console, timeoutMs = 5000 } = {}) {
  const raw = String(env.GYEONGGI_BUS_API_KEY || '').trim();
  const keyValue = raw && (/%[0-9A-Fa-f]{2}/.test(raw) ? raw : encodeURIComponent(raw)); // Encoding 키(% 포함)는 그대로
  const cap = Math.max(0, Math.min(1000, Number(env.GYEONGGI_BUS_DAILY_CAP) || 900));
  const cacheSec = Math.max(10, Math.min(300, Number(env.GYEONGGI_BUS_CACHE_SEC) || 30));
  const today = () => seoulParts(new Date(clock())).dateKey;
  const zero = () => ({ station: 0, arrival: 0, route: 0 });
  const zeroLive = () => ({ used: 0, empty: 0, skipped: 0, failed: 0 });
  const state = { date: today(), calls: zero(), testRuns: 0, lastOkAt: null, lastError: null, quota: {}, live: zeroLive() };
  let testCache = null, testInflight = null;
  const liveTimeoutMs = Math.min(timeoutMs, 4000); // 실제 경로 계산에 쓰는 호출은 4초까지만 기다림
  const judged = new Map(), judging = new Map();   // v2.5.0 판단 결과(정류장 기준) · 판단 중
  const judgeStats = Object.fromEntries(JUDGE_KINDS.map((k) => [k, 0]));
  const judgePath = { around: 0, keyword: 0, aroundFailed: 0 }; // v2.5.1 정류장을 주변 정류소 · 이름 검색 중 어디서 찾았는지 · 주변 정류소를 못 받은 판단 수
  const arrCache = new Map(), arrInflight = new Map(); // 정류장 ID → { at, r }
  const redact = (s) => {
    let t = String(s ?? '');
    for (const k of [raw, keyValue, raw && encodeURIComponent(raw)]) if (k) t = t.split(k).join('[KEY]');
    return t;
  };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  if (kv) {
    for (const svc of Object.keys(GG_SERVICES)) kv.getNum(CNT(svc, state.date)).then((n) => { if (state.date === today()) state.calls[svc] = Math.max(state.calls[svc], n); }, () => {});
    kv.getNum(TEST_CNT(state.date)).then((n) => { if (state.date === today()) state.testRuns = Math.max(state.testRuns, n); }, () => {});
  }
  function roll() { if (state.date !== today()) Object.assign(state, { date: today(), calls: zero(), testRuns: 0, quota: {}, live: zeroLive() }); }
  async function count(svc) {
    roll();
    state.calls[svc] += 1;
    if (kv) { try { state.calls[svc] = Math.max(state.calls[svc], await kv.incr(CNT(svc, state.date), 2 * 86400)); } catch { /* 메모리 카운터로 */ } }
    return state.calls[svc];
  }

  /** 기능 하나 부르기 → parseGbis 결과 + ms. 실패해도 예외 대신 status로. 그 서비스가 오늘 공공데이터포털 한도를 넘었으면 부르지 않음 */
  async function get(svc, op, params, { wait = timeoutMs } = {}) {
    roll();
    if (state.quota[svc] === today()) return { status: 'quota', code: null, message: '', items: [], shape: null, ms: 0 };
    if ((await count(svc)) > cap) return { status: 'cap', code: null, message: '', items: [], shape: null, ms: 0 };
    const qs = new URLSearchParams({ format: 'json', ...params });
    const url = `${BASE}/${GG_SERVICES[svc].path}/${op}?serviceKey=${keyValue}&${qs}`;
    const t0 = Date.now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), wait);
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      const r = parseGbis(await res.text(), res.status ?? 200);
      const out = { ...r, message: redact(r.message), ms: Date.now() - t0 };
      if (RANK.includes(out.status)) state.lastOkAt = clock();
      else {
        if (out.status === 'quota') state.quota[svc] = today();
        state.lastError = { kind: out.status, service: GG_SERVICES[svc].name, op, message: out.message || out.code || out.status, at: clock() }; // v2.5.1 op: 어느 기능이 실패했는지
      }
      return out;
    } catch (e) {
      const message = ctrl.signal.aborted ? `경기도 버스 API가 ${wait / 1000}초 안에 답하지 않았어요` : redact(e?.message || e).slice(0, 120);
      state.lastError = { kind: 'error', service: GG_SERVICES[svc].name, op, message, at: clock() };
      log.warn?.(`[gyeonggi] ${op}: ${message}`);
      return { status: 'error', code: null, message, items: [], shape: null, ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  }
  const step = (n, svc, op, input, r) => ({
    step: n, service: GG_SERVICES[svc].name, op, input, status: r.status, ...(r.code != null ? { resultCode: r.code } : {}), ...(r.message ? { resultMessage: r.message } : {}),
    count: r.items.length, ...(r.ms != null ? { ms: r.ms } : {}), shape: r.shape, fields: fieldsOf(r.items), sample: sampleOf(op, r.items[0]),
  });
  const skipped = (n, svc, op, input) => ({ step: n, service: GG_SERVICES[svc].name, op, input, status: 'skipped', count: 0, shape: null, fields: [], sample: null });

  /* ── v2.5.0 G2 ── */
  /**
   * 첫 버스 정류장이 경기도 정류장인지 판단(①~③). pre로 이미 받은 응답(주변 정류소 · 경유 노선)을 넘기면 그 호출은 하지 않음(확인 도구)
   * @returns {Promise<{ status: string, stationId?, stationName?, regionName?, by?, distM?, routes?: Array<{ no, routeId, staOrder }> }>}
   */
  async function judge(leg, { pre = {}, wait = liveTimeoutMs } = {}) {
    const inp = legInput(leg);
    if (!inp.ok) return { status: 'badInput' };
    // ① 주변 정류소(500m) → 없으면 이름 검색
    const around = pre.around || await get('station', 'getBusStationAroundListv2', { x: String(inp.lon), y: String(inp.lat) }, { wait });
    const aroundOk = RANK.includes(around.status);
    // v2.5.1 키 · 승인 · 한도 문제면 이름 검색도 같은 서비스라 부르지 않고 실패. 그 밖(시간 초과 · 연결 실패 · 5xx · 형식 다름)은 이름 검색으로 이어감
    if (!aroundOk && NO_FALLBACK.includes(around.status)) return { status: 'failed', reason: around.status, aroundStatus: around.status };
    const lost = aroundOk ? {} : { aroundStatus: around.status }; // 주변 정류소를 못 봄
    let pick = aroundOk ? chooseStop(around.items, inp) : null, path = 'around', keyword = null;
    if (!pick) {
      const kw = str(inp.name).split('.')[0].replace(/\(.*?\)/g, '').trim();
      if (kw) {
        keyword = kw; path = 'keyword';
        const byName = await get('station', 'getBusStationListv2', { keyword: kw }, { wait });
        if (!RANK.includes(byName.status)) return { status: 'failed', reason: byName.status, ...lost, keyword };
        // v2.5.1 이름 검색 목록에서 고를 때는 번호 + 100m에 이름까지 같아야(주변 목록 없이는 같은 번호의 다른 정류장이 근처에 있는지 모름)
        pick = chooseStop(byName.items, inp, { requireName: true });
      }
    }
    const kwf = keyword ? { keyword } : {};
    if (pick?.ambiguous) return { status: 'ambiguous', ...lost, ...kwf };
    // 못 찾음: 주변 정류소를 봤으면 '못 찾음'(1일), 주변 정류소를 못 봤으면 확실하지 않으니 '실패'(다시 판단)
    if (!pick) return aroundOk ? { status: 'notFound', ...kwf } : { status: 'failed', reason: keyword ? 'keyword-none' : around.status, ...lost, ...kwf };
    const st = pick.station, region = cut(st.regionName, 20);
    const base = { stationId: pick.id, stationName: cut(st.stationName), regionName: region, by: pick.by, distM: pick.d, path, ...lost, ...kwf };
    // ② 지역
    if (/서울/.test(region)) return { status: 'seoul', ...base };
    if (/인천/.test(region)) return { status: 'incheon', ...base };
    if (!region) return { status: 'noRegion', ...base };
    // ③ 경유 노선 — 경로의 버스 번호가 있고 방향이 하나(같은 번호가 두 노선이거나 같은 노선이 두 번 지나면 안 씀)
    const via = pre.via && pre.viaFor === pick.id ? pre.via : await get('station', 'getBusStationViaRouteListv2', { stationId: pick.id }, { wait });
    if (!RANK.includes(via.status)) return { status: 'failed', reason: via.status, path, ...lost, ...kwf };
    const routes = [];
    let twice = 0;
    for (const no of inp.buses) {
      const hits = via.items.filter((r) => busNo(r.routeName) === no);
      if (!hits.length) continue;
      const ids = [...new Set(hits.map((r) => str(r.routeId)))];
      if (ids.length !== 1 || hits.length !== 1 || !/^\d{5,12}$/.test(ids[0])) { twice++; continue; }
      routes.push({ no, routeId: ids[0], staOrder: num(hits[0].staOrder) });
    }
    if (!routes.length) return { status: twice ? 'twoWay' : 'noRoute', ...base };
    return { status: 'usable', ...base, routes };
  }
  async function judgeAndKeep(leg, key) {
    let value;
    try { value = await judge(leg); } catch (e) { value = { status: 'failed', reason: 'error' }; log.warn?.(`[gyeonggi] 판단: ${redact(e?.message || e).slice(0, 120)}`); }
    judgeStats[value.status] = (judgeStats[value.status] || 0) + 1;
    if (value.path === 'around' || value.path === 'keyword') judgePath[value.path]++;
    if (value.aroundStatus) judgePath.aroundFailed++;
    // v2.5.1 실패가 이어지면 다시 판단할 때까지 10 → 20 → 40 → 60분(다른 결과가 나오면 처음부터)
    const fails = value.status === 'failed' ? (judged.get(key)?.fails || 0) + 1 : 0;
    judged.set(key, { at: clock(), ttl: fails ? failTtl(fails) : JUDGE_TTL[value.status] ?? DAY_MS, value, fails });
    if (judged.size > 500) judged.delete(judged.keys().next().value);
    return value;
  }
  /**
   * 첫 버스 정류장 판단 결과(보관한 것). 없으면 뒤에서 판단을 시작하고 null — 이번 요청은 지금처럼 서울시로(응답이 느려지지 않게)
   */
  function stopFor(leg) {
    if (!raw) return null;
    const { key } = legInput(leg);
    if (!key) return null;
    const c = judged.get(key);
    if (c && clock() - c.at < c.ttl) return c.value;
    if (!judging.has(key)) judging.set(key, judgeAndKeep(leg, key).finally(() => judging.delete(key)));
    return null;
  }
  /** (테스트 · 확인용) 뒤에서 하던 판단이 모두 끝날 때까지 기다림 */
  async function settle() { await Promise.all([...judging.values()]); }

  /** 정류장 도착 정보(30초 · 사용자끼리 나눠 씀, 동시에 물어도 한 번) */
  async function stationArrivals(stationId) {
    const c = arrCache.get(stationId);
    if (c && clock() - c.at < cacheSec * 1000) return c;
    if (arrInflight.has(stationId)) return arrInflight.get(stationId);
    const p = get('arrival', 'getBusArrivalListv2', { stationId }, { wait: liveTimeoutMs }).then((r) => {
      const v = { at: clock(), r };
      // 정상 · 결과 없음은 30초, 그 밖(오류 · 상한 · 한도)도 30초 동안은 다시 부르지 않음
      arrCache.set(stationId, v);
      if (arrCache.size > 300) arrCache.delete(arrCache.keys().next().value);
      return v;
    }).finally(() => arrInflight.delete(stationId));
    arrInflight.set(stationId, p);
    return p;
  }
  /**
   * 쓸 수 있는 정류장(judge usable)의 첫 버스 도착 → transitLive의 first 값({ source: 'gyeonggi', buses } 등)
   *   buses: [{ no, etasSec(받은 뒤 흐른 시간을 뺀 초), termMin(경로의 배차간격 — 그 뒤 차는 배차로 이어 붙임), msgs: [] }]
   */
  async function arrivalsFor(j, leg) {
    roll();
    const { at, r } = await stationArrivals(j.stationId);
    if (!RANK.includes(r.status)) {
      state.live.failed++;
      return { source: r.status === 'cap' || r.status === 'quota' ? 'cap' : 'error', reason: r.status, region: 'gyeonggi', buses: [] };
    }
    const age = Math.max(0, (clock() - at) / 1000), term = num(leg?.intervalMin) > 0 ? num(leg.intervalMin) : null;
    const buses = [];
    for (const rt of j.routes || []) {
      const item = r.items.find((a) => str(a.routeId) === rt.routeId && (rt.staOrder == null || num(a.staOrder) == null || num(a.staOrder) === rt.staOrder));
      if (!item) continue;
      const flag = str(item.flag).toUpperCase();
      if (flag === 'STOP' || flag === 'WAIT') continue; // 운행 종료 · 회차지 대기는 쓰지 않음
      const etas = [1, 2].map((k) => etaOf(item, k)).filter((x) => x != null).map((x) => Math.round(x - age)).filter((x) => x > -30).map((x) => Math.max(0, x));
      if (etas.length) buses.push({ no: rt.no, etasSec: etas, termMin: term, msgs: [] });
    }
    if (buses.length) state.live.used++; else state.live.empty++;
    return { source: 'gyeonggi', region: 'gyeonggi', buses };
  }
  /** transitLive: 경기도 정류장인데 출발 30분 전보다 일러서 부르지 않은 횟수 */
  function noteSkip() { roll(); state.live.skipped++; }

  async function runTest() {
    roll();
    const base = { note: NOTE, maxPerDay: GG_TEST_MAX_PER_DAY, stage: 'G2' };
    if (!raw) return { ok: false, reason: 'no-key', message: 'GYEONGGI_BUS_API_KEY가 없어 시험하지 않았어요.', runsToday: state.testRuns, ...base, at: iso(clock()) };
    if (state.testRuns >= GG_TEST_MAX_PER_DAY) return { ok: false, reason: 'test-limit', message: `오늘 시험 ${GG_TEST_MAX_PER_DAY}번을 다 썼어요. 내일 다시 열어 주세요.`, runsToday: state.testRuns, ...base, at: iso(clock()) };
    roll();
    state.testRuns += 1;
    if (kv) { try { state.testRuns = Math.max(state.testRuns, await kv.incr(TEST_CNT(state.date), 2 * 86400)); } catch { /* 메모리로 */ } }
    if (state.testRuns > GG_TEST_MAX_PER_DAY) return { ok: false, reason: 'test-limit', message: `오늘 시험 ${GG_TEST_MAX_PER_DAY}번을 다 썼어요. 내일 다시 열어 주세요.`, runsToday: GG_TEST_MAX_PER_DAY, ...base, at: iso(clock()) };
    const runs = state.testRuns;
    const steps = [];
    // ① 정류소 이름 검색(고정 이름) → 정류장 하나 고르기(숫자 ID가 있는 첫 정류장)
    const s1 = await get('station', 'getBusStationListv2', { keyword: GG_TEST.keyword });
    steps.push(step(1, 'station', 'getBusStationListv2', { keyword: GG_TEST.keyword }, s1));
    const found = s1.items.find((x) => /^\d{5,12}$/.test(str(x.stationId)));
    const picked = found
      ? { from: 'keyword', stationId: str(found.stationId), stationName: cut(found.stationName), mobileNo: cut(found.mobileNo, 12), regionName: cut(found.regionName, 20), x: str(found.x).slice(0, 14), y: str(found.y).slice(0, 14) }
      : { from: 'fallback', stationId: GG_TEST.fallbackStationId, x: GG_TEST.fallbackX, y: GG_TEST.fallbackY };
    const x = /^\d{2,3}\.\d+$/.test(picked.x) ? picked.x : GG_TEST.fallbackX, y = /^\d{2}\.\d+$/.test(picked.y) ? picked.y : GG_TEST.fallbackY;
    let s2, s3, s5, s4, routeId = GG_TEST.fallbackRouteId, via = null;
    if (s1.status === 'auth') {
      // 키가 아예 등록 · 전파되지 않음 → 나머지도 같으니 부르지 않음(한도 아끼기)
      steps.push(skipped(2, 'arrival', 'getBusArrivalListv2', { stationId: picked.stationId }), skipped(3, 'station', 'getBusStationViaRouteListv2', { stationId: picked.stationId }),
        skipped(4, 'route', 'getBusRouteStationListv2', { routeId }), skipped(5, 'station', 'getBusStationAroundListv2', { x, y }));
    } else {
      // ② 그 정류장 도착 정보 · ③ 지나는 노선 · ⑤ 주변 정류소(좌표) — 서로 기다리지 않음
      [s2, s3, s5] = await Promise.all([
        get('arrival', 'getBusArrivalListv2', { stationId: picked.stationId }),
        get('station', 'getBusStationViaRouteListv2', { stationId: picked.stationId }),
        get('station', 'getBusStationAroundListv2', { x, y }),
      ]);
      via = s3.items.find((r) => /^\d{5,12}$/.test(str(r.routeId))) || null;
      if (via) routeId = str(via.routeId);
      // ④ 그 노선이 지나는 정류소 목록
      s4 = await get('route', 'getBusRouteStationListv2', { routeId });
      steps.push(step(2, 'arrival', 'getBusArrivalListv2', { stationId: picked.stationId }, s2), step(3, 'station', 'getBusStationViaRouteListv2', { stationId: picked.stationId }, s3),
        step(4, 'route', 'getBusRouteStationListv2', { routeId }, s4), step(5, 'station', 'getBusStationAroundListv2', { x, y }, s5));
    }
    // 서비스별 판정: 그 서비스 호출 중 가장 좋은 결과(작동 > 결과 없음 > 그 밖의 첫 결과)
    const services = {};
    for (const [svc, def] of Object.entries(GG_SERVICES)) {
      const mine = steps.filter((s) => s.service === def.name);
      const best = mine.find((s) => s.status === 'ok') || mine.find((s) => s.status === 'nodata') || mine.find((s) => s.status !== 'skipped') || mine[0];
      services[svc] = { name: def.name, status: best?.status || 'skipped', result: VERDICT[best?.status] || VERDICT.api };
    }
    const working = Object.values(services).every((s) => RANK.includes(s.status));
    // 형식 확인(G2 준비): 도착 초 단위 · 주변 정류소 반경 · 노선의 정류장 순서와 경유 노선의 staOrder가 맞는지 · 서울/경기/인천 구분
    const routeItem = s4?.items.find((r) => str(r.stationId) === picked.stationId) || null;
    const checks = s2 ? {
      arrivalSeconds: { withSeconds: s2.items.filter((a) => num(a.predictTimeSec1) != null).length, of: s2.items.length },
      // v2.5.1 status: '주변 정류소 0곳(nodata)'과 '응답 없음(error 등)'을 구분
      around: { status: s5.status, count: s5.items.length, distanceField: s5.items.some((a) => own(a, 'distance')), maxDistance: s5.items.reduce((m, a) => Math.max(m, num(a.distance) ?? 0), 0) || null },
      route: { routeId, fromVia: Boolean(via), stations: s4.items.length, hasPickedStation: Boolean(routeItem),
        stationSeq: routeItem ? num(routeItem.stationSeq) : null, viaStaOrder: via ? num(via.staOrder) : null,
        staOrderMatches: routeItem && via && num(routeItem.stationSeq) != null && num(via.staOrder) != null ? num(routeItem.stationSeq) === num(via.staOrder) : null,
        districtCd: countBy(s4.items, 'districtCd') },
    } : null;
    // v2.5.0 ⑥ 판단 순서 자가 검증: ①에서 고른 정류장을 '첫 버스 정류장'으로 놓고 G2 판단이 그 정류장 · 그 노선을 다시 찾는지(⑤ · ③ 응답을 그대로 써서 호출 거의 없음)
    //   v2.5.1 ⑤ 주변 정류소가 실패하면 실제 판단과 똑같이 이름 검색으로 이어감(이때만 1건 더) — path · aroundStatus · keyword로 어느 길로 판단했는지 보여 줌
    let selfJudge = null;
    if (s2 && picked.from === 'keyword' && via) {
      const pseudo = { from: { name: picked.stationName, x: picked.x, y: picked.y, arsId: picked.mobileNo }, buses: [str(via.routeName)], no: str(via.routeName) };
      const j = await judge(pseudo, { pre: { around: s5, via: s3, viaFor: picked.stationId }, wait: timeoutMs });
      const sameStation = j.stationId === picked.stationId, sameRoute = (j.routes || []).some((r) => r.routeId === routeId);
      const how = j.path === 'keyword' ? ' — 주변 정류소 대신 이름 검색' : '';
      selfJudge = {
        status: j.status, ...(j.reason ? { reason: j.reason } : {}), path: j.path || null, ...(j.aroundStatus ? { aroundStatus: j.aroundStatus } : {}), ...(j.keyword ? { keyword: cut(j.keyword) } : {}),
        by: j.by || null, distM: j.distM ?? null, regionName: j.regionName || null, sameStation, sameRoute,
        result: j.status === 'usable' && sameStation && sameRoute ? `판단 순서 통과(번호 · 거리 · 지역 · 노선${how})`
          : j.status === 'twoWay' ? '확인 필요: 이 노선이 이 정류장을 두 번 지나요(그런 버스는 경기도 정보를 쓰지 않아요)'
            : `확인 필요: ${j.status}${j.reason ? `(${j.reason})` : ''}`,
      };
    }
    const night = (() => { const m = seoulParts(new Date(clock())).minutes; return m >= 30 && m < 5 * 60; })();
    return {
      ok: working, ...(working ? {} : { reason: Object.values(services).find((s) => !RANK.includes(s.status)).status }),
      services, picked, checks, ...(selfJudge ? { selfJudge } : {}), steps, runsToday: runs, ...base,
      ...(night ? { nightNote: '심야라 도착 정보가 비어 있을 수 있어요(정류소 · 노선 확인에는 지장 없음).' } : {}), at: iso(clock()),
    };
  }
  /** /api/gyeonggi/test — 10분 안에 다시 열면 보관한 결과(cached: true), 동시에 여러 번 열어도 한 번만 */
  async function test() {
    if (testCache && clock() - testCache.at < TEST_TTL_MS) return { ...testCache.value, cached: true };
    if (testInflight) return testInflight;
    testInflight = runTest().then((value) => {
      if (!['no-key', 'test-limit'].includes(value.reason)) testCache = { at: clock(), value: { ...value, cached: false } };
      return { ...value, cached: false };
    }).finally(() => { testInflight = null; });
    return testInflight;
  }

  return {
    keyConfigured: Boolean(raw),
    test,
    stopFor,
    arrivalsFor,
    noteSkip,
    settle,
    judge,
    health() {
      roll();
      return {
        keyConfigured: Boolean(raw), stage: 'G2', use: '출발지 첫 버스가 경기도 정류장이면 출발 30분 전부터 경기도 도착 정보(+ 확인 도구)', cap, cacheSec,
        callsToday: { ...state.calls }, quotaToday: Object.values(state.quota).includes(today()), capReached: state.calls.arrival >= cap,
        lastOkAt: iso(state.lastOkAt), lastError: state.lastError && { ...state.lastError, at: iso(state.lastError.at) },
        // 판단 결과 개수(서버가 켜진 뒤 · 정류장 이름 · ID 없음) · 오늘 첫 버스 도착 정보를 쓴 횟수
        stops: { known: judged.size, ...judgeStats }, live: { ...state.live },
        judgePath: { ...judgePath }, // v2.5.1 주변 정류소로 찾은 판단 · 이름 검색으로 찾은 판단 · 주변 정류소를 못 받은 판단(개수만)
        test: { runsToday: state.testRuns, maxPerDay: GG_TEST_MAX_PER_DAY, lastAt: iso(testCache?.at) },
      };
    },
  };
}
