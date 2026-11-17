// ODsay 대중교통 길찾기(searchPubTransPathT) — 출발지 → 국민대학교 정문(126.9972, 37.6109) 추천 경로 최대 3개
//   · 키: encodeURIComponent(ODSAY_API_KEY) — 키에 + · / · = 가 있어도 인증이 깨지지 않게
//   · 모든 요청에 Referer(ODsay 콘솔 'URI(웹)' 플랫폼에 등록한 주소, 기본 https://ku-bus-ai.onrender.com)
//   · 무료 한도(하루 30건) 보호: 새 호출은 하루 ODSAY_DAILY_CAP(기본 25)건까지 — 외부 DB의 날짜별 카운터로 세어 서버를 다시 켜도 그대로
//   · 같은 출발지(이름이 같고 1km 안 · 또는 GPS 300m 안)는 외부 DB에 30일 저장한 결과를 모든 사용자가 같이 씀(호출 안 함)
//   · 한도 초과 · 키 없음 · 오류는 예외 대신 { ok:false, fallback:'direct' } → 화면이 단일 정류장 직행으로 안내
import { KOOKMIN_GATE, TRANSIT, distanceM, fallbackText, parseOdsayResult } from '../../../shared/transitPlan.js';
import { seoulParts } from '../../../shared/time.js';

const BASE = 'https://api.odsay.com/v1/api/searchPubTransPathT';
const DAY = 86400;
const TTL_SEC = 30 * DAY;          // 경로 검색 결과
const EMPTY_TTL_SEC = 7 * DAY;     // '경로 없음'도 7일 기억(같은 곳에서 다시 호출하지 않게)
const IDX = 'kubusai:odsay:idx';
const RES = (k) => `kubusai:odsay:r:${k}`;
const CNT = (d) => `kubusai:odsay:calls:${d}`;
export const nameKey = (s) => String(s || '').replace(/\s+/g, '').replace(/역$/, '').toLowerCase().slice(0, 40);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** ODsay 오류 코드 → 이유 */
export function odsayReason(err) {
  const code = String(err?.code ?? ''), msg = String(err?.message ?? '');
  if (/ApiKeyAuthFailed|apikey/i.test(msg)) return 'auth';
  if (code === '-98') return 'near';
  if (['-99', '3', '4', '5'].includes(code)) return 'no-path';
  if (code === '6') return 'out-of-area';
  return 'error';
}
/** 응답 모양(이름만, 값 없음) — 실제 응답 필드 확인용(/api/health) */
function shapeOf(json) {
  const p = json?.result?.path?.[0];
  const subKeys = new Set(), laneKeys = new Set();
  for (const s of p?.subPath || []) { Object.keys(s || {}).forEach((k) => subKeys.add(k)); for (const l of s?.lane || []) Object.keys(l || {}).forEach((k) => laneKeys.add(k)); }
  return { top: Object.keys(json || {}), path: Object.keys(p || {}), info: Object.keys(p?.info || {}), subPath: [...subKeys].sort(), lane: [...laneKeys].sort() };
}

/**
 * @param {{ env?, kv, fetchImpl?, clock?, log?, timeoutMs? }} o  kv = createKv() (외부 DB 또는 메모리)
 */
export function createOdsayService({ env = process.env, kv, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = console, timeoutMs = 8000 } = {}) {
  const key = String(env.ODSAY_API_KEY || '').trim();
  const referer = String(env.ODSAY_REFERER || '').trim() || 'https://ku-bus-ai.onrender.com';
  const cap = Math.max(0, Math.min(30, Number(env.ODSAY_DAILY_CAP) || 25));
  const today = () => seoulParts(new Date(clock())).dateKey;
  const state = { date: today(), calls: 0, hits: 0, lastOkAt: null, lastError: null, lastFallback: null, lastShape: null, index: null, indexAt: 0 };
  const redact = (s) => (key ? String(s ?? '').split(key).join('[KEY]').split(encodeURIComponent(key)).join('[KEY]') : String(s ?? ''));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const noteErr = (kind, message, code = null) => { state.lastError = { kind, code, message: redact(message).slice(0, 200), at: clock() }; };
  // 서버를 켤 때 오늘 호출 수를 외부 DB에서 읽어 둠(health 표시용)
  kv.getNum(CNT(state.date)).then((n) => { if (state.date === today()) state.calls = Math.max(state.calls, n); }, () => {});

  async function loadIndex() {
    if (state.index && clock() - state.indexAt < 30_000) return state.index;
    const raw = await kv.hgetall(IDX), idx = {}, gone = [];
    for (const [k, v] of Object.entries(raw)) {
      try { const e = JSON.parse(v); if (e.exp > clock()) idx[k] = e; else gone.push(k); } catch { gone.push(k); }
    }
    for (const k of gone) kv.hdel(IDX, k).catch(() => {});
    state.index = idx; state.indexAt = clock();
    return idx;
  }
  /** 같은 출발지: 이름이 같고 1km 안 · 또는 300m 안(가장 가까운 것) */
  async function findCached(o) {
    const idx = await loadIndex(), here = { x: o.lon, y: o.lat };
    let best = null, bestD = Infinity;
    for (const [k, e] of Object.entries(idx)) {
      const d = distanceM(here, { x: e.lon, y: e.lat });
      const sameName = o.kind !== 'gps' && o.name && e.name && nameKey(o.name) === nameKey(e.name) && d <= 1000;
      if ((sameName || d <= TRANSIT.cacheRadiusM) && (sameName ? -1 : d) < bestD) { best = k; bestD = sameName ? -1 : d; }
    }
    if (!best) return null;
    const v = await byId(best);
    if (!v) { delete idx[best]; kv.hdel(IDX, best).catch(() => {}); return null; }
    return v;
  }
  async function byId(id) {
    if (typeof id !== 'string' || id.length < 3 || id.length > 120 || !/^[ng]:/.test(id) || /[\s\u0000-\u001f]/.test(id)) return null;
    const raw = await kv.get(RES(id));
    if (!raw) return null;
    try { return { key: id, ...JSON.parse(raw) }; } catch { return null; }
  }
  async function save(entry, ttlSec) {
    const exp = clock() + ttlSec * 1000;
    await kv.set(RES(entry.key), JSON.stringify({ origin: entry.origin, paths: entry.paths, reason: entry.reason || null, at: entry.at }), ttlSec);
    await kv.hset(IDX, entry.key, JSON.stringify({ lat: entry.origin.lat, lon: entry.origin.lon, name: entry.origin.name, exp }));
    if (state.index) state.index[entry.key] = { lat: entry.origin.lat, lon: entry.origin.lon, name: entry.origin.name, exp };
  }
  function calls() {
    if (state.date !== today()) { state.date = today(); state.calls = 0; }
    return { today: Math.min(state.calls, cap), cap, left: Math.max(0, cap - state.calls) }; // 상한을 넘은 시도는 부르지 않았으니 세지 않음
  }

  async function request(o) {
    const url = `${BASE}?SX=${o.lon}&SY=${o.lat}&EX=${KOOKMIN_GATE.x}&EY=${KOOKMIN_GATE.y}&OPT=0&SearchType=0&SearchPathType=0&apiKey=${encodeURIComponent(key)}`;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { Referer: referer, Accept: 'application/json' }, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? `ODsay가 ${timeoutMs / 1000}초 안에 답하지 않았어요` : redact(e?.message || e));
    } finally { clearTimeout(timer); }
  }

  /**
   * 출발지 → 국민대 추천 경로(최대 3개)
   * @param {{ lat, lon, name?, kind?: 'gps'|'stop', arsId? }} q
   * @returns {Promise<{ ok, cached?, searchId?, origin?, paths?, at?, calls, fallback?, reason?, message? }>}
   */
  async function search({ lat, lon, name = '', kind = 'stop', arsId = '' } = {}) {
    const fb = (reason, extra = {}) => {
      state.lastFallback = { reason, at: clock() };
      return { ok: false, fallback: 'direct', reason, message: fallbackText(reason, cap), calls: calls(), ...extra };
    };
    if (!(Number(lat) >= 33 && Number(lat) <= 39 && Number(lon) >= 124 && Number(lon) <= 132)) return fb('bad');
    const origin = { name: String(name || '').trim().slice(0, 40) || (kind === 'gps' ? 'GPS로 고른 위치' : '출발지'), lat: r6(Number(lat)), lon: r6(Number(lon)), kind: kind === 'gps' ? 'gps' : 'stop', arsId: /^\d{5}$/.test(String(arsId)) ? String(arsId) : '' };
    const distM = Math.round(distanceM({ x: origin.lon, y: origin.lat }, KOOKMIN_GATE));
    if (distM < TRANSIT.nearMinM) return fb('near', { distM });
    try {
      const hit = await findCached(origin);
      if (hit) {
        state.hits++;
        if (!hit.paths?.length) return fb(hit.reason || 'no-path', { cached: true });
        return { ok: true, cached: true, searchId: hit.key, origin: { ...hit.origin, name: origin.kind === 'gps' ? hit.origin.name : origin.name }, paths: hit.paths, at: hit.at, calls: calls() };
      }
    } catch (e) { noteErr('store', `저장된 검색 결과를 읽지 못했어요: ${e.message}`); }
    if (!key) return fb('no-key');
    let n;
    try { n = await kv.incr(CNT(today()), 2 * DAY); } catch (e) { noteErr('store', e.message); return fb('store'); }
    state.date = today(); state.calls = Math.max(state.calls, n);
    if (n > cap) return fb('cap');
    let json;
    try { json = await request(origin); } catch (e) { noteErr('error', e.message); log.warn?.(`[odsay] ${redact(e.message)}`); return fb('error'); }
    state.lastShape = shapeOf(json);
    const r = parseOdsayResult(json);
    const entryKey = origin.kind === 'gps' ? `g:${origin.lat.toFixed(4)},${origin.lon.toFixed(4)}` : `n:${nameKey(origin.name)}:${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}`;
    const at = iso(clock());
    if (!r.ok) {
      const reason = r.error.code === 'format' ? 'error' : odsayReason(r.error);
      noteErr(reason, r.error.message, r.error.code);
      if (['no-path', 'near', 'out-of-area'].includes(reason)) save({ key: entryKey, origin, paths: [], reason, at }, EMPTY_TTL_SEC).catch(() => {});
      return fb(reason, { code: r.error.code });
    }
    state.lastOkAt = clock();
    try { await save({ key: entryKey, origin, paths: r.paths, at }, TTL_SEC); } catch (e) { noteErr('store', `검색 결과를 저장하지 못했어요: ${e.message}`); }
    return { ok: true, cached: false, searchId: entryKey, origin, paths: r.paths, at, calls: calls() };
  }

  return {
    keyConfigured: Boolean(key),
    search,
    byId,
    health() {
      const c = calls();
      return {
        keyConfigured: Boolean(key), referer, cap, callsToday: c.today, left: c.left, date: state.date, store: kv.kind,
        cachedOrigins: state.index ? Object.keys(state.index).length : null, cacheHits: state.hits,
        lastOkAt: iso(state.lastOkAt), lastError: state.lastError && { ...state.lastError, at: iso(state.lastError.at) },
        lastFallback: state.lastFallback && { ...state.lastFallback, at: iso(state.lastFallback.at) }, lastShape: state.lastShape,
      };
    },
  };
}
