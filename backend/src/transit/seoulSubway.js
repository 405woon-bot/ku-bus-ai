// 서울시 실시간 지하철 도착정보(SEOUL_SUBWAY_KEY) — http://swopenapi.seoul.go.kr/api/subway/{KEY}/json/realtimeStationArrival/0/20/{역명}
//   · 역마다 30초 캐시(SEOUL_SUBWAY_CACHE_SEC) · 하루 900건 상한(SEOUL_SUBWAY_DAILY_CAP, 키 한도 1,000건/일) — 외부 DB 날짜별 카운터
//   · 이름이 안 맞으면(INFO-200) 괄호를 뺀 이름으로 한 번 더 · 한도 초과(ERROR-337)면 그날은 쉼
//   · 실패해도 예외 대신 source로 알림 → 계산은 ODsay 표준 대기 시간으로(화면에 '예상')
import { parseSubwayArrivals, stationKey } from '../../../shared/subwayArrivals.js';
import { seoulParts } from '../../../shared/time.js';

const BASE = 'http://swopenapi.seoul.go.kr/api/subway';
const CNT = (d) => `kubusai:subway:calls:${d}`;

export function createSubwayService({ env = process.env, kv = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = console, timeoutMs = 5000 } = {}) {
  const key = String(env.SEOUL_SUBWAY_KEY || '').trim();
  const cap = Math.max(0, Math.min(1000, Number(env.SEOUL_SUBWAY_DAILY_CAP) || 900));
  const ttlMs = Math.max(10, Number(env.SEOUL_SUBWAY_CACHE_SEC) || 30) * 1000;
  const today = () => seoulParts(new Date(clock())).dateKey;
  const state = { date: today(), calls: 0, lastOkAt: null, lastError: null, quotaDate: null };
  const cache = new Map(), inflight = new Map();
  const redact = (s) => (key ? String(s ?? '').split(key).join('[KEY]').split(encodeURIComponent(key)).join('[KEY]') : String(s ?? ''));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  if (kv) kv.getNum(CNT(state.date)).then((n) => { if (state.date === today()) state.calls = Math.max(state.calls, n); }, () => {});

  async function count() {
    if (state.date !== today()) { state.date = today(); state.calls = 0; }
    state.calls += 1;
    if (kv) { try { state.calls = Math.max(state.calls, await kv.incr(CNT(state.date), 2 * 86400)); } catch { /* 메모리 카운터로 */ } }
    return state.calls;
  }
  async function call(name) {
    const url = `${BASE}/${encodeURIComponent(key)}/json/realtimeStationArrival/0/20/${encodeURIComponent(name)}`;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? `서울시 실시간 지하철이 ${timeoutMs / 1000}초 안에 답하지 않았어요` : redact(e?.message || e));
    } finally { clearTimeout(timer); }
  }

  async function load(name) {
    const names = [...new Set([String(name).trim().replace(/역$/, ''), stationKey(name)])].filter(Boolean);
    let last = null;
    for (const n of names) {
      if (state.quotaDate === today()) return { source: 'quota', reason: 'quota', rows: [] };
      if ((await count()) > cap) return { source: 'cap', reason: 'cap', rows: [] };
      let json;
      try { json = await call(n); } catch (e) { state.lastError = { kind: 'api', message: e.message, at: clock() }; return { source: 'error', reason: 'api', message: e.message, rows: [] }; }
      const r = parseSubwayArrivals(json, clock());
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

  return {
    keyConfigured: Boolean(key),
    arrivals,
    health() {
      if (state.date !== today()) { state.date = today(); state.calls = 0; }
      return {
        keyConfigured: Boolean(key), cap, callsToday: state.calls, cacheSec: ttlMs / 1000, stations: cache.size,
        lastOkAt: iso(state.lastOkAt), lastError: state.lastError && { ...state.lastError, at: iso(state.lastError.at) },
        quotaToday: state.quotaDate === today(),
      };
    },
  };
}
