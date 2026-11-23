// ODsay 대중교통 길찾기(searchPubTransPathT) — 출발지 → 국민대학교 정문(126.9972, 37.6109) 추천 경로 최대 3개
//   · 키: encodeURIComponent(ODSAY_API_KEY) — 키에 + · / · = 가 있어도 인증이 깨지지 않게
//   · 모든 요청에 Referer(ODsay 콘솔 'URI(웹)' 플랫폼에 등록한 주소, 기본 https://ku-bus-ai.onrender.com)
//   · 무료 한도(하루 30건) 보호: 새 호출은 하루 ODSAY_DAILY_CAP(기본 25)건까지 — 외부 DB의 날짜별 카운터로 세어 서버를 다시 켜도 그대로
//   · 같은 출발지(이름이 같고 1km 안 · 또는 300m 안)는 외부 DB에 저장한 결과를 모든 사용자가 같이 씀(호출 안 함)
//   · v2.1 저장 기간: 30일 동안은 '새 결과', 90일까지 남겨 두고 한도 초과 · 키 없음 · ODsay 오류 때만 '예전 경로'(날짜 표시)로 씀
//   · 한도 초과 · 키 없음 · 오류는 예외 대신 { ok:false, fallback:'direct', reason } → 화면이 근처 국민대행 정류장 · 안내로 넘어감
//   · v2.2.3 GPS 출발지는 약 100m 칸(소수 셋째 자리)으로 저장 · 응답(키도 g:칸). ODsay에 묻는 순간에만 정확한 좌표를 쓰고 저장하지 않음.
//     예전에 정밀하게 저장한 GPS 항목은 coarsenGps()가 같은 칸으로 옮김(경로 · 보관 기한은 그대로)
import { KOOKMIN_GATE, TRANSIT, distanceM, fallbackText, parseOdsayResult, staleText } from '../../../shared/transitPlan.js';
import { coarseOrigin, gpsKey, isCoarse } from '../../../shared/geoPrivacy.js';
import { seoulParts } from '../../../shared/time.js';

const BASE = 'https://api.odsay.com/v1/api/searchPubTransPathT';
const DAY = 86400;
const FRESH_SEC = 30 * DAY;        // 경로 검색 결과: 이 기간은 '새 결과'로 바로 씀
const KEEP_SEC = 90 * DAY;         // v2.1 그 뒤 90일까지는 지우지 않고, 새로 찾을 수 없을 때만 '예전 경로'로
const EMPTY_TTL_SEC = 7 * DAY;     // '경로 없음'도 7일 기억(같은 곳에서 다시 호출하지 않게) — 예전 값으로는 쓰지 않음
const OLD_GRACE_SEC = 600;         // v2.2.3 칸으로 옮긴 예전 GPS 항목: 열려 있던 화면이 그 검색 번호로 저장할 수 있게 10분만 더 남김
const IDX = 'kubusai:odsay:idx';
const RES = (k) => `kubusai:odsay:r:${k}`;
const CNT = (d) => `kubusai:odsay:calls:${d}`;
export const nameKey = (s) => String(s || '').replace(/\s+/g, '').replace(/역$/, '').toLowerCase().slice(0, 40);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
/** 예전 경로를 쓸 수 있는 실패 이유(새로 찾을 수 없음). '경로 없음' · '700m 안'은 ODsay의 새 답이 맞으므로 쓰지 않음 */
const STALE_OK = new Set(['cap', 'no-key', 'error', 'store', 'auth']);

/** ODsay 오류 코드 → 이유 */
export function odsayReason(err) {
  const code = String(err?.code ?? ''), msg = String(err?.message ?? '');
  if (/ApiKeyAuthFailed|apikey/i.test(msg)) return 'auth';
  if (code === '-98') return 'near';
  if (['-99', '3', '4', '5'].includes(code)) return 'no-path';
  if (code === '6') return 'out-of-area';
  return 'error';
}
/** 응답 모양(이름만, 값 없음) — 실제 응답 필드 확인용(/api/health). v2.1: 경유 정류장(passStopList.stations) 필드 이름도 */
function shapeOf(json) {
  const p = json?.result?.path?.[0];
  const subKeys = new Set(), laneKeys = new Set(), stKeys = new Set();
  for (const s of p?.subPath || []) {
    Object.keys(s || {}).forEach((k) => subKeys.add(k));
    for (const l of s?.lane || []) Object.keys(l || {}).forEach((k) => laneKeys.add(k));
    for (const st of (s?.passStopList?.stations || []).slice(0, 3)) Object.keys(st || {}).forEach((k) => stKeys.add(k));
  }
  return { top: Object.keys(json || {}), path: Object.keys(p || {}), info: Object.keys(p?.info || {}), subPath: [...subKeys].sort(), lane: [...laneKeys].sort(), station: [...stKeys].sort() };
}

/**
 * @param {{ env?, kv, fetchImpl?, clock?, log?, timeoutMs? }} o  kv = createKv() (외부 DB 또는 메모리)
 */
export function createOdsayService({ env = process.env, kv, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = console, timeoutMs = 8000 } = {}) {
  const key = String(env.ODSAY_API_KEY || '').trim();
  const referer = String(env.ODSAY_REFERER || '').trim() || 'https://ku-bus-ai.onrender.com';
  const cap = Math.max(0, Math.min(30, Number(env.ODSAY_DAILY_CAP) || 25));
  const today = () => seoulParts(new Date(clock())).dateKey;
  const state = { date: today(), calls: 0, hits: 0, staleServed: 0, lastOkAt: null, lastError: null, lastFallback: null, lastShape: null, index: null, indexAt: 0 };
  const redact = (s) => (key ? String(s ?? '').split(key).join('[KEY]').split(encodeURIComponent(key)).join('[KEY]') : String(s ?? ''));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const noteErr = (kind, message, code = null) => { state.lastError = { kind, code, message: redact(message).slice(0, 200), at: clock() }; };
  // 서버를 켤 때 오늘 호출 수를 외부 DB에서 읽어 둠(health 표시용)
  kv.getNum(CNT(state.date)).then((n) => { if (state.date === today()) state.calls = Math.max(state.calls, n); }, () => {});

  /** 저장된 출발지 목록: 보관이 끝난 것만 지움. fresh(새 결과로 쓰는 기한)가 없는 예전(v2.0) 항목은 exp(30일)가 곧 fresh */
  async function loadIndex() {
    if (state.index && clock() - state.indexAt < 30_000) return state.index;
    const raw = await kv.hgetall(IDX), idx = {}, gone = [];
    for (const [k, v] of Object.entries(raw)) {
      try { const e = JSON.parse(v); if (e.exp > clock()) idx[k] = { ...e, fresh: e.fresh ?? e.exp, legacy: !e.fresh }; else gone.push(k); } catch { gone.push(k); }
    }
    for (const k of gone) kv.hdel(IDX, k).catch(() => {});
    state.index = idx; state.indexAt = clock();
    return idx;
  }
  /** 같은 출발지(이름이 같고 1km 안 · 또는 300m 안) 중 가장 가까운 것 — 새 결과가 있으면 그것을, 없으면 예전 결과 */
  async function findCached(o) {
    const idx = await loadIndex(), here = { x: o.lon, y: o.lat }, t = clock();
    const pick = (fresh) => {
      let best = null, bestD = Infinity;
      for (const [k, e] of Object.entries(idx)) {
        if ((e.fresh > t) !== fresh) continue;
        const d = distanceM(here, { x: e.lon, y: e.lat });
        const sameName = o.kind !== 'gps' && o.name && e.name && nameKey(o.name) === nameKey(e.name) && d <= 1000;
        if ((sameName || d <= TRANSIT.cacheRadiusM) && (sameName ? -1 : d) < bestD) { best = k; bestD = sameName ? -1 : d; }
      }
      return best;
    };
    for (const fresh of [true, false]) {
      const k = pick(fresh);
      if (!k) continue;
      const v = await byId(k);
      if (!v) { delete idx[k]; kv.hdel(IDX, k).catch(() => {}); continue; }
      if (!fresh && !v.paths?.length) continue; // '경로 없음'은 예전 값으로 쓰지 않음
      if (fresh && idx[k].legacy && v.paths?.length) keepLonger(k, v, idx[k]); // v2.0에 저장한 결과도 90일까지 남김
      const ageDays = Math.max(0, Math.floor((t - (Date.parse(v.at) || t)) / (DAY * 1000)));
      return { v, stale: !fresh, ageDays };
    }
    return null;
  }
  /** v2.0(30일만 보관)으로 저장된 결과를 처음 다시 쓸 때: 찾은 날 + 90일까지 남기도록 보관 기간을 늘림 */
  function keepLonger(k, v, e) {
    const at = Date.parse(v.at) || clock();
    const exp = at + KEEP_SEC * 1000, ttl = Math.ceil((exp - clock()) / 1000);
    if (ttl <= 0) return;
    const next = { lat: e.lat, lon: e.lon, name: e.name, exp, fresh: e.fresh };
    e.exp = exp; e.legacy = false;
    kv.expire(RES(k), ttl).then(() => kv.hset(IDX, k, JSON.stringify(next))).catch(() => {});
  }
  async function byId(id) {
    if (typeof id !== 'string' || id.length < 3 || id.length > 120 || !/^[ng]:/.test(id) || /[\s\u0000-\u001f]/.test(id)) return null;
    const raw = await kv.get(RES(id));
    if (!raw) return null;
    try { return { key: id, ...JSON.parse(raw) }; } catch { return null; }
  }
  async function save(entry, freshSec, keepSec = freshSec) {
    const t = clock(), exp = t + keepSec * 1000, fresh = t + freshSec * 1000;
    const ix = { lat: entry.origin.lat, lon: entry.origin.lon, name: entry.origin.name, exp, fresh };
    await kv.set(RES(entry.key), JSON.stringify({ origin: entry.origin, paths: entry.paths, reason: entry.reason || null, at: entry.at }), keepSec);
    await kv.hset(IDX, entry.key, JSON.stringify(ix));
    if (state.index) state.index[entry.key] = { ...ix, legacy: false };
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
   * @returns {Promise<{ ok, cached?, stale?, ageDays?, staleReason?, searchId?, origin?, paths?, at?, calls, fallback?, reason?, message? }>}
   */
  async function search({ lat, lon, name = '', kind = 'stop', arsId = '' } = {}) {
    const fb = (reason, extra = {}) => {
      state.lastFallback = { reason, at: clock() };
      return { ok: false, fallback: 'direct', reason, message: fallbackText(reason, cap), calls: calls(), ...extra };
    };
    if (!(Number(lat) >= 33 && Number(lat) <= 39 && Number(lon) >= 124 && Number(lon) <= 132)) return fb('bad');
    // exact = 지금 묻는 위치(ODsay 요청 · 같은 곳 찾기 · 거리 계산에만, 저장하지 않음) · origin = 저장 · 응답용(GPS면 약 100m 칸)
    const exact = { name: String(name || '').trim().slice(0, 40) || (kind === 'gps' ? 'GPS로 고른 위치' : '출발지'), lat: r6(Number(lat)), lon: r6(Number(lon)), kind: kind === 'gps' ? 'gps' : 'stop', arsId: /^\d{5}$/.test(String(arsId)) ? String(arsId) : '' };
    const origin = coarseOrigin(exact);
    const distM = Math.round(distanceM({ x: exact.lon, y: exact.lat }, KOOKMIN_GATE));
    if (distM < TRANSIT.nearMinM) return fb('near', { distM });
    const nameOf = (hit) => (origin.kind === 'gps' ? hit.origin.name : origin.name);
    let old = null; // 예전 경로(30~90일): 새로 찾을 수 없을 때만
    try {
      const hit = await findCached(exact);
      if (hit && !hit.stale) {
        state.hits++;
        if (!hit.v.paths?.length) return fb(hit.v.reason || 'no-path', { cached: true });
        return { ok: true, cached: true, searchId: hit.v.key, origin: coarseOrigin({ ...hit.v.origin, name: nameOf(hit.v) }), paths: hit.v.paths, at: hit.v.at, calls: calls() };
      }
      if (hit?.stale) old = hit;
    } catch (e) { noteErr('store', `저장된 검색 결과를 읽지 못했어요: ${e.message}`); }
    const useOld = (reason, extra = {}) => {
      if (!old || !STALE_OK.has(reason)) return fb(reason, extra);
      state.staleServed++; state.lastFallback = { reason, at: clock(), stale: true };
      return { ok: true, cached: true, stale: true, staleReason: reason, ageDays: old.ageDays, message: staleText(reason, old.ageDays, cap),
        searchId: old.v.key, origin: coarseOrigin({ ...old.v.origin, name: nameOf(old.v) }), paths: old.v.paths, at: old.v.at, calls: calls() };
    };
    if (!key) return useOld('no-key');
    let n;
    try { n = await kv.incr(CNT(today()), 2 * DAY); } catch (e) { noteErr('store', e.message); return useOld('store'); }
    state.date = today(); state.calls = Math.max(state.calls, n);
    if (n > cap) return useOld('cap');
    let json;
    try { json = await request(exact); } catch (e) { noteErr('error', e.message); log.warn?.(`[odsay] ${redact(e.message)}`); return useOld('error'); }
    state.lastShape = shapeOf(json);
    const r = parseOdsayResult(json);
    const entryKey = origin.kind === 'gps' ? gpsKey(origin.lat, origin.lon) : `n:${nameKey(origin.name)}:${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}`;
    const at = iso(clock());
    if (!r.ok) {
      const reason = r.error.code === 'format' ? 'error' : odsayReason(r.error);
      noteErr(reason, r.error.message, r.error.code);
      if (['no-path', 'near', 'out-of-area'].includes(reason)) save({ key: entryKey, origin, paths: [], reason, at }, EMPTY_TTL_SEC).catch(() => {});
      return useOld(reason, { code: r.error.code });
    }
    state.lastOkAt = clock();
    try { await save({ key: entryKey, origin, paths: r.paths, at }, FRESH_SEC, KEEP_SEC); } catch (e) { noteErr('store', `검색 결과를 저장하지 못했어요: ${e.message}`); }
    return { ok: true, cached: false, searchId: entryKey, origin, paths: r.paths, at, calls: calls() };
  }

  /**
   * v2.2.3 예전에 정밀하게 저장한 GPS 출발지 항목(키 g:소수 넷째 자리 · 좌표 소수 여섯째 자리)을 약 100m 칸으로 옮김.
   *   경로 · 검색 시각 · 보관 기한(exp) · 새 결과 기한(fresh, 없으면 v2.0 항목 그대로)은 바꾸지 않음. 역 · 정류장 항목(n:)은 건드리지 않음.
   *   같은 칸에 같거나 더 새로운 결과가 이미 있으면 예전 것만 지움. 순서: 새 칸에 쓰기 → 목록에 넣기 → 예전 목록에서 빼기 →
   *   예전 결과는 10분 뒤 사라지게. 중간에 실패해도 다시 돌리면 이어서 처리(이미 칸이면 건너뜀)
   * @returns {Promise<{ gps, moved, merged, skipped }>}
   */
  async function coarsenGps() {
    const raw = await kv.hgetall(IDX), t = clock(), out = { gps: 0, moved: 0, merged: 0, skipped: 0 };
    const idx = {};
    for (const [k, v] of Object.entries(raw)) { try { idx[k] = JSON.parse(v); } catch { /* 깨진 항목은 loadIndex가 정리 */ } }
    for (const k of Object.keys(idx)) {
      if (!k.startsWith('g:') || !idx[k]) continue;
      out.gps++;
      const e = idx[k], lat = Number(e.lat), lon = Number(e.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { out.skipped++; continue; }
      const nk = gpsKey(lat, lon);
      if (nk === k && isCoarse(lat) && isCoarse(lon)) continue; // 이미 칸
      if (!(e.exp > t)) { out.skipped++; continue; }            // 보관이 끝난 항목은 loadIndex가 지움
      const v = await byId(k);
      if (!v) { await kv.hdel(IDX, k); delete idx[k]; out.skipped++; continue; }
      const cur = nk !== k ? idx[nk] : null;
      if (cur && cur.exp > t && (cur.fresh ?? cur.exp) >= (e.fresh ?? e.exp)) { // 같은 칸에 같거나 더 새로운 결과
        await kv.hdel(IDX, k); await kv.expire(RES(k), OLD_GRACE_SEC); delete idx[k]; out.merged++; continue;
      }
      const origin = coarseOrigin({ ...v.origin, kind: 'gps' });
      const ttl = Math.max(1, Math.ceil((e.exp - t) / 1000));
      await kv.set(RES(nk), JSON.stringify({ origin, paths: v.paths, reason: v.reason || null, at: v.at }), ttl);
      const ix = { lat: origin.lat, lon: origin.lon, name: e.name, exp: e.exp, ...(e.fresh ? { fresh: e.fresh } : {}) };
      await kv.hset(IDX, nk, JSON.stringify(ix));
      idx[nk] = ix;
      if (nk !== k) { await kv.hdel(IDX, k); await kv.expire(RES(k), OLD_GRACE_SEC); delete idx[k]; }
      out.moved++;
    }
    state.index = null; // 목록을 다시 읽게
    return out;
  }

  /** v2.1 미리 찾아 두기용: 이 이름(같은 이름 키)으로 저장된 '새 결과'가 언제까지 새것인지(ms, 없으면 0) · 경로 없음으로 기억했는지 */
  async function freshness(name) {
    const idx = await loadIndex(), k = nameKey(name);
    let until = 0, empty = false;
    for (const [id, e] of Object.entries(idx)) {
      if (!id.startsWith('n:') || nameKey(e.name) !== k || e.fresh <= clock()) continue;
      if (e.fresh > until) { until = e.fresh; empty = !e.legacy && e.exp === e.fresh; } // '경로 없음'은 새 기한 = 보관 기한(7일)
    }
    return { until, empty };
  }
  /** 오늘 쓴 새 호출 수(외부 DB 카운터 그대로 — 서버가 여럿이거나 다시 켜져도 정확) */
  async function usedToday() {
    const n = await kv.getNum(CNT(today()));
    if (state.date === today()) state.calls = Math.max(state.calls, n);
    return Math.min(n, cap);
  }

  return {
    keyConfigured: Boolean(key),
    cap,
    search,
    byId,
    coarsenGps,
    freshness,
    usedToday,
    health() {
      const c = calls();
      return {
        keyConfigured: Boolean(key), referer, cap, callsToday: c.today, left: c.left, date: state.date, store: kv.kind,
        cachedOrigins: state.index ? Object.keys(state.index).length : null, cacheHits: state.hits, staleServed: state.staleServed, freshDays: FRESH_SEC / DAY, keepDays: KEEP_SEC / DAY,
        lastOkAt: iso(state.lastOkAt), lastError: state.lastError && { ...state.lastError, at: iso(state.lastError.at) },
        lastFallback: state.lastFallback && { ...state.lastFallback, at: iso(state.lastFallback.at) }, lastShape: state.lastShape,
      };
    },
  };
}
