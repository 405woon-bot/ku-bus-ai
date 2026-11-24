// v2.4.0 경기도 버스 G1 — 공공데이터포털 경기도 버스 API(GBIS v2) 연결 확인 도구
//   경기도_정류소 조회 · 경기도_버스도착정보 조회 · 경기도_버스노선 조회(같은 일반 인증키)를 고정된 공개 입력으로 한 번씩 불러
//   키가 통하는지 · 응답 형식(머리말 · 목록 이름 · 필드 이름)이 안내와 같은지만 확인합니다. 경로 계산 · 화면에는 아직 쓰지 않아요(G2부터).
//   https://apis.data.go.kr/6410000/{서비스}/v2/{기능}?serviceKey=…&format=json&…
//   · 키 GYEONGGI_BUS_API_KEY(공공데이터포털 일반 인증키 — Decoding 권장, Encoding(% 포함)도 그대로): 서버 전용, 응답 · 로그 · health에 안 나옴
//   · 서비스별 하루 상한 GYEONGGI_BUS_DAILY_CAP(비우면 900, 최대 1,000 — 개발계정은 서비스마다 하루 1,000건) — 외부 DB 날짜별 카운터
//   · GYEONGGI_BUS_CACHE_SEC(비우면 30, 10~300): G2(첫 버스 실시간)부터 씀. 지금은 /api/health에 값만 보여 줌
//   · 확인 도구(/api/gyeonggi/test): 한 번에 최대 5건(정류소 3 · 도착 1 · 노선 1) · 결과 10분 보관 · 하루 3번 ·
//     키가 아예 등록되지 않았으면 첫 호출에서 멈춤 · 사용자 경로 · 위치와 무관(입력은 고정 이름 '수원역'과 그 응답에서 고른 값뿐)
import { seoulParts } from '../../../shared/time.js';

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
const NOTE = '고정된 공개 입력(정류장 이름 \'수원역\')으로 경기도 버스 API 3종을 시험한 결과예요. 사용자 경로 · 위치와 무관하고 인증키는 나오지 않아요. 같은 결과는 10분 동안 보관하고 하루 3번까지 새로 시험해요. 아직 경로 계산 · 화면에는 쓰지 않아요(G1).';

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

export function createGyeonggiBusService({ env = process.env, kv = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = console, timeoutMs = 5000 } = {}) {
  const raw = String(env.GYEONGGI_BUS_API_KEY || '').trim();
  const keyValue = raw && (/%[0-9A-Fa-f]{2}/.test(raw) ? raw : encodeURIComponent(raw)); // Encoding 키(% 포함)는 그대로
  const cap = Math.max(0, Math.min(1000, Number(env.GYEONGGI_BUS_DAILY_CAP) || 900));
  const cacheSec = Math.max(10, Math.min(300, Number(env.GYEONGGI_BUS_CACHE_SEC) || 30));
  const today = () => seoulParts(new Date(clock())).dateKey;
  const zero = () => ({ station: 0, arrival: 0, route: 0 });
  const state = { date: today(), calls: zero(), testRuns: 0, lastOkAt: null, lastError: null };
  let testCache = null, testInflight = null;
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
  function roll() { if (state.date !== today()) Object.assign(state, { date: today(), calls: zero(), testRuns: 0 }); }
  async function count(svc) {
    roll();
    state.calls[svc] += 1;
    if (kv) { try { state.calls[svc] = Math.max(state.calls[svc], await kv.incr(CNT(svc, state.date), 2 * 86400)); } catch { /* 메모리 카운터로 */ } }
    return state.calls[svc];
  }

  /** 기능 하나 부르기 → parseGbis 결과 + ms. 실패해도 예외 대신 status로 */
  async function get(svc, op, params) {
    if ((await count(svc)) > cap) return { status: 'cap', code: null, message: '', items: [], shape: null, ms: 0 };
    const qs = new URLSearchParams({ format: 'json', ...params });
    const url = `${BASE}/${GG_SERVICES[svc].path}/${op}?serviceKey=${keyValue}&${qs}`;
    const t0 = Date.now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      const r = parseGbis(await res.text(), res.status ?? 200);
      const out = { ...r, message: redact(r.message), ms: Date.now() - t0 };
      if (RANK.includes(out.status)) state.lastOkAt = clock();
      else state.lastError = { kind: out.status, service: GG_SERVICES[svc].name, message: out.message || out.code || out.status, at: clock() };
      return out;
    } catch (e) {
      const message = ctrl.signal.aborted ? `경기도 버스 API가 ${timeoutMs / 1000}초 안에 답하지 않았어요` : redact(e?.message || e).slice(0, 120);
      state.lastError = { kind: 'error', service: GG_SERVICES[svc].name, message, at: clock() };
      log.warn?.(`[gyeonggi] ${op}: ${message}`);
      return { status: 'error', code: null, message, items: [], shape: null, ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  }
  const step = (n, svc, op, input, r) => ({
    step: n, service: GG_SERVICES[svc].name, op, input, status: r.status, ...(r.code != null ? { resultCode: r.code } : {}), ...(r.message ? { resultMessage: r.message } : {}),
    count: r.items.length, ...(r.ms != null ? { ms: r.ms } : {}), shape: r.shape, fields: fieldsOf(r.items), sample: sampleOf(op, r.items[0]),
  });
  const skipped = (n, svc, op, input) => ({ step: n, service: GG_SERVICES[svc].name, op, input, status: 'skipped', count: 0, shape: null, fields: [], sample: null });

  async function runTest() {
    roll();
    const base = { note: NOTE, maxPerDay: GG_TEST_MAX_PER_DAY, stage: 'G1' };
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
      around: { count: s5.items.length, distanceField: s5.items.some((a) => own(a, 'distance')), maxDistance: s5.items.reduce((m, a) => Math.max(m, num(a.distance) ?? 0), 0) || null },
      route: { routeId, fromVia: Boolean(via), stations: s4.items.length, hasPickedStation: Boolean(routeItem),
        stationSeq: routeItem ? num(routeItem.stationSeq) : null, viaStaOrder: via ? num(via.staOrder) : null,
        staOrderMatches: routeItem && via && num(routeItem.stationSeq) != null && num(via.staOrder) != null ? num(routeItem.stationSeq) === num(via.staOrder) : null,
        districtCd: countBy(s4.items, 'districtCd') },
    } : null;
    const night = (() => { const m = seoulParts(new Date(clock())).minutes; return m >= 30 && m < 5 * 60; })();
    return {
      ok: working, ...(working ? {} : { reason: Object.values(services).find((s) => !RANK.includes(s.status)).status }),
      services, picked, checks, steps, runsToday: runs, ...base,
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
    health() {
      roll();
      return {
        keyConfigured: Boolean(raw), stage: 'G1', use: '확인 도구만(경로 계산 · 화면에는 아직 쓰지 않음)', cap, cacheSec,
        callsToday: { ...state.calls }, lastOkAt: iso(state.lastOkAt), lastError: state.lastError && { ...state.lastError, at: iso(state.lastError.at) },
        test: { runsToday: state.testRuns, maxPerDay: GG_TEST_MAX_PER_DAY, lastAt: iso(testCache?.at) },
      };
    },
  };
}
