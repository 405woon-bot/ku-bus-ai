// 서울시 실시간 지하철 도착정보(SEOUL_SUBWAY_KEY) — http://swopenapi.seoul.go.kr/api/subway/{KEY}/json/realtimeStationArrival/0/20/{역명}
//   · 역마다 30초 캐시(SEOUL_SUBWAY_CACHE_SEC) · 하루 900건 상한(SEOUL_SUBWAY_DAILY_CAP, 키 한도 1,000건/일) — 외부 DB 날짜별 카운터
//   · 이름이 안 맞으면(INFO-200) 괄호를 뺀 이름으로 한 번 더 · 한도 초과(ERROR-337)면 그날은 쉼
//   · 실패해도 예외 대신 source로 알림 → 계산은 ODsay 표준 대기 시간으로(화면에 '예상')
//   · v2.3.0 비상 끄기(SEOUL_SUBWAY_OFF_LINES='1065,1032'): 그 노선만 실시간을 부르지 않음(배차로 예상) — 코드 재배포 없이 되돌리는 손잡이
//   · v2.3.0 확인 도구(/api/subway/test): 고정된 공개 역 8곳의 응답 모양(노선 번호 · 열차 종류 값 · '○○방면' 형식)만 요약.
//     사용자 경로 · 위치와 무관 · 결과 10분 보관 · 하루 3번(외부 DB 카운터) · 심야엔 부르지 않음 · 하루 상한(900건) 안에서
//   · v2.3.0 /api/health에 허용 목록(켠 개수 · 끈 번호) · 오늘 열차를 뺀 횟수 · 목록 밖이라 부르지 않은 횟수 · 시험 횟수(역 · 노선별 사용 기록은 싣지 않음)
//   · v2.4.1 한 번에 40줄(…/0/40/역명, 호출 수는 그대로 1건) — 큰 환승역(서울역 등)에서 20줄에 잘리던 노선까지. 서울시가 40줄 요청을 받지 않으면
//     (처음 보는 오류 코드 · HTTP 4xx) 그날은 자동으로 20줄로 되돌리고 한 번 더(health rows · rowsFallback). 확인 도구는 노선별로 남은 시간을 어떻게 구했는지(eta) 개수도
//   · v2.5.2 방면 형식은 실제 계산과 같은 규칙(shared DIR_RE — 마지막 '-' 뒤)으로 셈 · 노선별 '종착이 역 이름이 아닌 줄'(oddDest, 예: '-2') 개수와 예 한 줄
import { DIR_RE, LIVE_LINES, liveLine, oddDest, parseOffLines, parseSubwayArrivals, rowEta, stationKey, subwayStatus } from '../../../shared/subwayArrivals.js';
import { seoulParts } from '../../../shared/time.js';

const BASE = 'http://swopenapi.seoul.go.kr/api/subway';
const ROWS = 40;      // v2.4.1 한 번에 받는 줄 수(…/0/40/역명) — 예전 20
const ROWS_SAFE = 20; // 서울시가 40줄 요청을 받지 않으면 그날은 이 값으로
const CNT = (d) => `kubusai:subway:calls:${d}`;
const TEST_CNT = (d) => `kubusai:subway:test:${d}`;

/* ── v2.3.0 확인 도구 ── */
// 고정된 공개 역(사용자 경로와 무관) — 시험할 노선이 지나는 서울 안 역. 경강선(1081)은 서울 안 역이 없어 시험하지 못함
export const TEST_STATIONS = Object.freeze(['서울', '왕십리', '상봉', '강남', '성신여대입구', '김포공항', '신림', '수서']);
// 광역 · 민자 노선(1~9호선 밖)마다 보일 것으로 기대하는 시험 역
export const TEST_EXPECT = Object.freeze({
  1063: ['서울', '왕십리', '상봉'], 1065: ['서울', '김포공항'], 1067: ['상봉'], 1075: ['왕십리', '수서'], 1077: ['강남'],
  1092: ['성신여대입구'], 1093: ['김포공항'], 1081: [], 1094: ['신림'], 1032: ['서울', '수서'],
});
export const TEST_MAX_PER_DAY = 3;
const TEST_TTL_MS = 10 * 60_000;
const TEST_NOTE = '고정된 공개 역 8곳으로 시험한 결과예요(사용자 경로 · 위치와 무관, 인증키는 나오지 않아요). 열차가 다니는 낮 시간에 열어 주세요. 같은 결과는 10분 동안 보관하고 하루 3번까지 새로 시험해요.';
// 첫 역에서 막혔을 때 이유별 안내(키 값은 싣지 않음)
const TEST_WHY = { auth: '인증키(SEOUL_SUBWAY_KEY)를 확인해 주세요', cap: '오늘 호출 상한에 닿았어요(한국 시각 자정에 초기화)', quota: '서울시 하루 한도를 넘었어요(한국 시각 자정에 초기화)', error: '서울시 연결을 확인해 주세요', api: '서울시 응답 형식이 달라요' };
const cut = (v, n = 40) => (v == null ? '' : String(v)).trim().slice(0, n);
const zero = () => ({ line: 0, dir: 0, type: 0, dest: 0 });

/**
 * 시험 결과 요약(원래 응답 줄 → 노선 번호별 모양). 고정된 공개 역의 공개 열차 정보만 — 사용자 정보 없음
 * @param {Array<{ station, status, rows: object[], message? }>} results 역별 결과(rows = 서울시 realtimeArrivalList 원문)
 */
export function summarizeTest(results, fetchedMs = Date.now()) {
  const stations = results.map((r) => ({ station: r.station, status: r.status, rows: r.rows.length, ...(r.asked ? { asked: r.asked } : {}),
    ...(r.rows.length >= (r.asked || ROWS) ? { full: true } : {}), ...(r.message ? { message: cut(r.message, 80) } : {}) }));
  // 바깥에서 온 값(노선 번호 · 열차 종류)을 이름으로 쓰므로 Map에 모았다가 마지막에 일반 객체로(객체 기본 이름과 섞이지 않게)
  const byId = new Map();
  for (const res of results) {
    for (const r of res.rows) {
      const raw = cut(r?.subwayId, 8), id = /^\d{1,6}$/.test(raw) ? raw : raw ? '(형식이 다른 번호)' : '(빈 번호)';
      const known = liveLine(id);
      if (!byId.has(id)) byId.set(id, { name: known?.name || '목록에 없는 번호', group: known?.group || null, rows: 0, types: new Map(), dirFormat: 0, etaZero: 0, eta: new Map(), oddDest: 0, oddDestSample: null, stations: [], sample: null });
      const L = byId.get(id);
      L.rows++;
      const t = cut(r?.btrainSttus, 12) || '(빈 칸)';
      L.types.set(t, (L.types.get(t) || 0) + 1);
      if (DIR_RE.test(cut(r?.trainLineNm, 60))) L.dirFormat++;
      if (!(Number(r?.barvlDt) > 0)) L.etaZero++;
      // v2.5.2 종착이 역 이름이 아닌 줄(숫자 · 기호뿐 — 실제 계산에서는 쓰지 않음) 개수와 처음 본 예 한 줄
      if (oddDest(r?.bstatnNm)) { L.oddDest++; if (!L.oddDestSample) L.oddDestSample = { station: res.station, trainLineNm: cut(r?.trainLineNm), bstatnNm: cut(r?.bstatnNm, 20) }; }
      const how = rowEta(r, fetchedMs).how; // v2.4.1 실제 계산과 같은 규칙으로: 초 · 도착 · 문구 · 몇 번째 전역 · 전역 코드 · 떠남 · 지난 기록 · 모름
      L.eta.set(how, (L.eta.get(how) || 0) + 1);
      if (!L.stations.includes(res.station)) L.stations.push(res.station);
      if (!L.sample) L.sample = { station: res.station, trainLineNm: cut(r?.trainLineNm), btrainSttus: cut(r?.btrainSttus, 12), arvlMsg2: cut(r?.arvlMsg2), updnLine: cut(r?.updnLine, 8), bstatnNm: cut(r?.bstatnNm, 20) };
    }
  }
  const lines = Object.fromEntries([...byId].map(([id, { oddDestSample, ...L }]) => [id, { ...L, types: Object.fromEntries(L.types), eta: Object.fromEntries(L.eta), ...(oddDestSample ? { oddDestSample } : {}) }]));
  // 광역 · 민자 노선 판정(1~9호선은 지금까지 쓰던 노선이라 판정하지 않음 — 보이면 lines에는 나옴)
  const check = {};
  for (const [id, want] of Object.entries(TEST_EXPECT)) {
    const L = byId.has(id) ? lines[id] : null, name = LIVE_LINES[id][0];
    let result;
    if (!want.length) result = '시험 역 없음(서울 안 역이 없는 노선)';
    else if (!L) result = '안 보임(열차가 없는 시간이거나, 서울시가 이 노선을 주지 않거나, 노선 번호가 달라요)';
    else if (LIVE_LINES[id][1] === 'strict' && !L.types['일반']) result = "확인 필요: '일반' 표시가 없어요(지금 규칙이면 이 노선은 실시간을 쓰지 않아요)";
    else if (L.dirFormat < L.rows) result = "확인 필요: '○○방면' 형식이 아닌 줄이 있어요";
    else result = '보임';
    check[id] = { name, result, expect: want };
  }
  const unknownIds = [...byId.keys()].filter((id) => !liveLine(id));
  return { stations, lines, check, unknownIds };
}

export function createSubwayService({ env = process.env, kv = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = console, timeoutMs = 5000 } = {}) {
  const key = String(env.SEOUL_SUBWAY_KEY || '').trim();
  const cap = Math.max(0, Math.min(1000, Number(env.SEOUL_SUBWAY_DAILY_CAP) || 900));
  const ttlMs = Math.max(10, Number(env.SEOUL_SUBWAY_CACHE_SEC) || 30) * 1000;
  const { off: offLines, ignored: offIgnored } = parseOffLines(env.SEOUL_SUBWAY_OFF_LINES);
  const today = () => seoulParts(new Date(clock())).dateKey;
  const state = { date: today(), calls: 0, lastOkAt: null, lastError: null, quotaDate: null, testRuns: 0, filtered: zero(), skipped: { line: 0, off: 0 }, rowsFallback: null };
  const cache = new Map(), inflight = new Map();
  let testCache = null, testInflight = null;
  const redact = (s) => (key ? String(s ?? '').split(key).join('[KEY]').split(encodeURIComponent(key)).join('[KEY]') : String(s ?? ''));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  if (kv) {
    kv.getNum(CNT(state.date)).then((n) => { if (state.date === today()) state.calls = Math.max(state.calls, n); }, () => {});
    kv.getNum(TEST_CNT(state.date)).then((n) => { if (state.date === today()) state.testRuns = Math.max(state.testRuns, n); }, () => {});
  }

  /** 한국 시각 자정이 지나면 오늘 카운터를 새로(호출 수 · 시험 횟수 · 뺀 열차 · 부르지 않은 횟수) */
  function roll() {
    if (state.date === today()) return;
    Object.assign(state, { date: today(), calls: 0, testRuns: 0, filtered: zero(), skipped: { line: 0, off: 0 } });
  }
  async function count() {
    roll();
    state.calls += 1;
    if (kv) { try { state.calls = Math.max(state.calls, await kv.incr(CNT(state.date), 2 * 86400)); } catch { /* 메모리 카운터로 */ } }
    return state.calls;
  }
  // v2.4.1 오늘 쓰는 줄 수: 40, 서울시가 40줄 요청을 받지 않은 날은 20
  const rowsNow = () => (state.rowsFallback?.date === today() ? ROWS_SAFE : ROWS);
  async function call(name, rows) {
    const url = `${BASE}/${encodeURIComponent(key)}/json/realtimeStationArrival/0/${rows}/${encodeURIComponent(name)}`;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.httpStatus = res.status; throw err; }
      return JSON.parse(text);
    } catch (e) {
      const err = new Error(ctrl.signal.aborted ? `서울시 실시간 지하철이 ${timeoutMs / 1000}초 안에 답하지 않았어요` : redact(e?.message || e));
      if (!ctrl.signal.aborted && e?.httpStatus) err.httpStatus = e.httpStatus;
      throw err;
    } finally { clearTimeout(timer); }
  }
  /**
   * v2.4.1 역 하나 받기(하루 상한 · 한도 초과 쉼 포함) → { json, asked } | { quota } | { cap } | { error }
   *   40줄 요청에 서울시가 처음 보는 오류 코드(subwayStatus 'api')나 HTTP 4xx로 답하면 그날은 20줄로 바꾸고 한 번 더(호출 1건 더 셈).
   *   시간 초과 · 연결 실패 · 5xx는 잠깐의 문제일 수 있어 줄 수를 바꾸지 않음
   */
  async function fetchStation(name) {
    let rows = rowsNow();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (state.quotaDate === today()) return { quota: true };
      if ((await count()) > cap) return { cap: true };
      let json;
      try { json = await call(name, rows); } catch (e) {
        if (attempt === 0 && rows === ROWS && e.httpStatus >= 400 && e.httpStatus < 500) { state.rowsFallback = { date: today(), reason: `HTTP ${e.httpStatus}`, at: clock() }; rows = ROWS_SAFE; continue; }
        return { error: e.message };
      }
      if (attempt === 0 && rows === ROWS && subwayStatus(json).status === 'api') { state.rowsFallback = { date: today(), reason: subwayStatus(json).code, at: clock() }; rows = ROWS_SAFE; continue; }
      return { json, asked: rows };
    }
    return { error: '서울시 응답을 받지 못했어요' };
  }

  async function load(name) {
    const names = [...new Set([String(name).trim().replace(/역$/, ''), stationKey(name)])].filter(Boolean);
    let last = null;
    for (const n of names) {
      const got = await fetchStation(n);
      if (got.quota) return { source: 'quota', reason: 'quota', rows: [] };
      if (got.cap) return { source: 'cap', reason: 'cap', rows: [] };
      if (got.error) { state.lastError = { kind: 'api', message: got.error, at: clock() }; return { source: 'error', reason: 'api', message: got.error, rows: [] }; }
      const r = parseSubwayArrivals(got.json, clock());
      if (r.status === 'ok') { state.lastOkAt = clock(); return { source: 'seoul', station: n, rows: r.rows }; }
      last = r;
      if (r.status !== 'nodata') break;
    }
    if (last.status === 'quota') state.quotaDate = today();
    if (last.status !== 'nodata') state.lastError = { kind: last.status, message: `${last.code} ${last.message}`.trim(), at: clock() };
    return { source: last.status === 'nodata' ? 'nodata' : last.status === 'quota' ? 'quota' : 'error', reason: last.status, message: last.message, rows: [] };
  }

  /**
   * 역 하나의 실시간 도착(열차마다 남은 초 · 방면 · 종착). fetchedAt 기준이라 쓰는 쪽에서 흐른 시간을 빼야 함
   * @returns {Promise<{ source:'seoul'|'off'|'cap'|'quota'|'nodata'|'error', rows, fetchedAt, station?, reason?, message? }>}
   */
  async function arrivals(stationName) {
    const name = String(stationName || '').trim();
    if (!key) return { source: 'off', reason: 'no-key', rows: [], fetchedAt: iso(clock()) };
    if (!name) return { source: 'error', reason: 'no-station', rows: [], fetchedAt: iso(clock()) };
    const c = cache.get(name);
    if (c && clock() - c.at < c.ttl) return c.value;
    if (inflight.has(name)) return inflight.get(name);
    const p = load(name).then((v) => {
      const value = { ...v, fetchedAt: iso(clock()) };
      // 정상은 30초, 이름이 안 맞는 역은 10분(다시 물어도 같음), 오류는 30초 동안 다시 묻지 않음
      cache.set(name, { at: clock(), ttl: v.source === 'nodata' ? 600_000 : ttlMs, value });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      if (v.source === 'error') log.warn?.(`[subway] ${name}: ${v.message || v.reason}`);
      return value;
    }).finally(() => inflight.delete(name));
    inflight.set(name, p);
    return p;
  }

  /* ── v2.3.0 확인 도구 ── */
  // 시험용: 해석하기 전 원래 응답 줄 그대로(고정된 공개 역에만 씀). 하루 상한 · 한도 초과 쉼 · 오류 기록은 실제 호출과 똑같이
  async function probe(name) {
    const got = await fetchStation(name);
    if (got.quota) return { station: name, status: 'quota', rows: [] };
    if (got.cap) return { station: name, status: 'cap', rows: [] };
    if (got.error) { state.lastError = { kind: 'api', message: got.error, at: clock() }; return { station: name, status: 'error', message: got.error, rows: [] }; }
    const json = got.json;
    const st = subwayStatus(json);
    if (st.status === 'ok') { state.lastOkAt = clock(); return { station: name, status: 'ok', rows: json.realtimeArrivalList.slice(0, 100), asked: got.asked }; }
    if (st.status === 'quota') state.quotaDate = today();
    if (st.status !== 'nodata') state.lastError = { kind: st.status, message: `${st.code} ${st.message}`.trim(), at: clock() };
    return { station: name, status: st.status, message: redact(st.message), rows: [] };
  }
  async function countTest() {
    roll();
    state.testRuns += 1;
    if (kv) { try { state.testRuns = Math.max(state.testRuns, await kv.incr(TEST_CNT(state.date), 2 * 86400)); } catch { /* 메모리 카운터로 */ } }
    return state.testRuns;
  }
  const linesInfo = () => ({ total: Object.keys(LIVE_LINES).length, on: Object.keys(LIVE_LINES).length - offLines.size, off: [...offLines], ...(offIgnored ? { offIgnored } : {}) });

  async function runTest() {
    roll();
    const base = { note: TEST_NOTE, maxPerDay: TEST_MAX_PER_DAY, allow: linesInfo() }; // allow = 허용 목록(켠 개수 · 끈 번호), lines = 이번에 본 노선별 모양
    if (!key) return { ok: false, reason: 'no-key', message: 'SEOUL_SUBWAY_KEY가 없어 시험하지 않았어요.', runsToday: state.testRuns, ...base, at: iso(clock()) };
    const m = seoulParts(new Date(clock())).minutes;
    if (m >= 30 && m < 5 * 60 + 30) return { ok: false, reason: 'night', message: '열차가 다니지 않는 시간(00:30~05:30)이라 시험하지 않았어요. 낮에 다시 열어 주세요.', runsToday: state.testRuns, ...base, at: iso(clock()) };
    if (state.quotaDate === today()) return { ok: false, reason: 'quota', message: '오늘 서울시 호출 한도를 넘어 시험하지 않았어요. 내일 다시 열어 주세요.', runsToday: state.testRuns, ...base, at: iso(clock()) };
    if (state.testRuns >= TEST_MAX_PER_DAY) return { ok: false, reason: 'test-limit', message: `오늘 시험 ${TEST_MAX_PER_DAY}번을 다 썼어요. 내일 다시 열어 주세요.`, runsToday: state.testRuns, ...base, at: iso(clock()) };
    const runs = await countTest();
    if (runs > TEST_MAX_PER_DAY) return { ok: false, reason: 'test-limit', message: `오늘 시험 ${TEST_MAX_PER_DAY}번을 다 썼어요. 내일 다시 열어 주세요.`, runsToday: TEST_MAX_PER_DAY, ...base, at: iso(clock()) };
    // 먼저 한 역으로 키 · 연결을 확인하고, 되면 나머지 7역을 한꺼번에(키가 틀리거나 막혔으면 더 부르지 않음)
    const first = await probe(TEST_STATIONS[0]);
    const rest = ['ok', 'nodata'].includes(first.status)
      ? await Promise.all(TEST_STATIONS.slice(1).map(probe))
      : TEST_STATIONS.slice(1).map((s) => ({ station: s, status: 'skipped', rows: [] }));
    const all = [first, ...rest];
    const ok = all.some((r) => r.status === 'ok');
    const fail = ok ? {} : ['ok', 'nodata'].includes(first.status)
      ? { reason: 'nodata', message: '시험 역 모두 열차 정보가 없어요 — 열차가 다니는 낮 시간에 다시 열어 주세요.' }
      : { reason: first.status, message: `첫 역(${first.station})에서 '${first.status}' — ${TEST_WHY[first.status] || '서울시 연결을 확인해 주세요'}(나머지 역은 부르지 않았어요).` };
    return { ok, ...fail, ...summarizeTest(all, clock()), rowsAsked: rowsNow(), runsToday: runs, ...base, at: iso(clock()) };
  }
  /** /api/subway/test — 10분 안에 다시 열면 보관한 결과(cached: true), 동시에 여러 번 열어도 한 번만 시험 */
  async function test() {
    if (testCache && clock() - testCache.at < TEST_TTL_MS) return { ...testCache.value, cached: true };
    if (testInflight) return testInflight;
    testInflight = runTest().then((value) => {
      if (value.ok || !['no-key', 'night', 'quota', 'test-limit'].includes(value.reason)) testCache = { at: clock(), value: { ...value, cached: false } };
      return { ...value, cached: false };
    }).finally(() => { testInflight = null; });
    return testInflight;
  }

  /** transitLive: 첫 지하철에서 뺀 열차 이유 합계({ line, dir, type, dest }) · 허용 목록 밖('line') / 비상 끄기('off')로 부르지 않은 횟수 */
  function countFiltered(drops) {
    roll();
    for (const k of Object.keys(state.filtered)) state.filtered[k] += Number(drops?.[k]) || 0;
  }
  function countSkip(reason) {
    roll();
    if (reason === 'line' || reason === 'off') state.skipped[reason] += 1;
  }

  return {
    keyConfigured: Boolean(key),
    offLines,
    arrivals,
    test,
    countFiltered,
    countSkip,
    health() {
      roll();
      return {
        keyConfigured: Boolean(key), cap, callsToday: state.calls, cacheSec: ttlMs / 1000, stations: cache.size,
        lastOkAt: iso(state.lastOkAt), lastError: state.lastError && { ...state.lastError, at: iso(state.lastError.at) },
        quotaToday: state.quotaDate === today(), rows: rowsNow(),
        rowsFallback: state.rowsFallback?.date === today() ? { reason: state.rowsFallback.reason, at: iso(state.rowsFallback.at) } : null,
        lines: linesInfo(), filtered: { ...state.filtered }, skipped: { ...state.skipped },
        test: { runsToday: state.testRuns, maxPerDay: TEST_MAX_PER_DAY, lastAt: iso(testCache?.at) },
      };
    },
  };
}
