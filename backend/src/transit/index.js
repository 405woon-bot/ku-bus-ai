// 실시간 소요시간 공급(LiveService)
//   서울시 API(30초 캐시 + 백그라운드 갱신) → 실패하면 마지막 정상값(3분 이내) → 그래도 없으면 예시(모의) 데이터로 자동 폴백
//   응답의 노선마다 source('seoul'|'mock')를, 전체에 provider·reason을 붙여 화면 배지와 푸시 문구가 출처를 밝히게 합니다.
import fs from 'node:fs';
import path from 'node:path';
import { mockLive } from '../../../shared/transitModel.js';
import { routeStatus } from '../../../shared/departure.js';
import { mainReason, reasonText } from '../../../shared/liveStatus.js';
import { seoulParts } from '../../../shared/time.js';
import { mockTrips } from '../../../shared/stopTrips.js';
import { SeoulApiError, createSeoulAdapter, createSeoulClient } from './seoulBus.js';
import { createMemoryCache } from './cache.js';
import { BUS_MID_SKIPS, MID_REUSE_SEC, createMidBudget, parseMidCap } from './midBudget.js';

/** v2.7.0 환승 버스(서울시 정류장) 하루 몫 기본값 · 서울시 정류장 조회(정류소정보조회) 보호선 — 오늘 이만큼 부르면 환승 버스만 멈춤(첫 · 마지막 버스는 그대로) */
export const SEOUL_BUS_MID_DEFAULT_CAP = 100;
export const SEOUL_BUS_MID_GUARD = 800;
const SEOUL_SVCS = ['stationinfo', 'busRouteInfo']; // 정류소정보조회 · 노선정보조회
const SEOUL_CNT = (svc, d) => `kubusai:seoulbus:calls:${svc}:${d}`;
const SEOUL_MID_CNT = (d) => `kubusai:seoulbus:mid:${d}`;

/** 상태 칩·지연 분 계산을 붙인 노선 */
const withStatus = (r) => {
  const delayMin = Number.isFinite(r.liveMin) && Number.isFinite(r.usualMin) ? Math.max(0, Math.round(r.liveMin - r.usualMin)) : null;
  return { ...r, delayMin, status: delayMin == null ? null : routeStatus(delayMin) };
};

export function createMockProvider(scenario = 'jeongneung') {
  const noSearch = async () => { throw new SeoulApiError('no-key', '예시 데이터 모드에서는 정류장을 검색할 수 없어요'); };
  return {
    name: 'mock',
    async live(routes, now) {
      const r = mockLive(routes, scenario, seoulParts(now).minutes);
      return { ...r, routes: r.routes.map(withStatus), source: 'mock', provider: 'mock' };
    },
    async stopTrips(_arsId, now = new Date()) {
      return { trips: mockTrips(seoulParts(now).minutes, scenario), source: 'mock', reason: 'demo', reasonText: reasonText('demo'), stale: false, ageSec: 0, fetchedAt: now.toISOString() };
    },
    searchStops: noSearch,
    nearStops: noSearch,
    // 환승 경로의 첫 버스는 예시 데이터로 대신하지 않음(실시간이 없으면 표준 대기 시간)
    stopArrivals: async () => { throw new SeoulApiError('no-key', '예시 데이터 모드에서는 정류장 도착 정보가 없어요'); },
  };
}

/**
 * 평소 소요시간: (노선, 요일, 15분 칸)별 지수이동평균. 하루에 한 칸은 한 번만 반영하고, 반영한 그날에는
 * 오늘 값을 넣기 전의 평균을 '평소'로 돌려줍니다 → 오늘의 정체가 같은 날 '평소'로 바뀌어 지연이 사라지지 않음.
 * 기록이 없으면 null → 사용자가 넣은 usualMin. file을 주면 서버를 다시 켜도 유지됩니다.
 */
export function createBaseline({ alpha = 0.2, file = null } = {}) {
  let data = { m: {} };
  if (file && fs.existsSync(file)) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 새로 시작 */ } }
  let timer = null;
  const save = () => {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }, 500);
    timer.unref?.();
  };
  const slot = (now) => { const p = seoulParts(now); return [`${p.weekday}:${Math.floor(p.minutes / 15)}`, p.dateKey]; };
  const entry = (k) => { const e = data.m[k]; return typeof e === 'number' ? { v: e, prev: null, day: null } : e; };
  return {
    record(routeId, now, minutes) {
      const [s, day] = slot(now), k = `${routeId}|${s}`, e = entry(k);
      if (e?.day === day) return;
      data.m[k] = { prev: e?.v ?? null, v: e?.v == null ? minutes : e.v + alpha * (minutes - e.v), day };
      save();
    },
    usual(routeId, now) {
      const [s, day] = slot(now), e = entry(`${routeId}|${s}`);
      if (!e) return null;
      const v = e.day === day ? e.prev : e.v;
      return v == null ? null : Math.round(v);
    },
  };
}

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} [o.env]  SEOUL_BUS_API_KEY · SEOUL_BUS_BASE_URL · SEOUL_BUS_FORMAT · SEOUL_BUS_KEY_PARAM · LIVE_CACHE_SEC · MOCK_SCENARIO
 * @param {Function} [o.fetchImpl]     테스트에서 서울시 응답을 바꿔 끼움
 * @param {object} [o.cache]           createMemoryCache() 또는 createRedisCache()
 * @param {boolean} [o.background=true] 30초마다 최근 요청된 노선을 미리 갱신
 */
export function createLiveService({
  env = process.env, fetchImpl, cache = createMemoryCache(), baseline = createBaseline(), log = console,
  staleMaxMs = 3 * 60_000, quotaCooldownMs = 15 * 60_000, activeWindowMs = 15 * 60_000, background = true, clock = () => Date.now(), kv = null,
} = {}) {
  const ttlMs = Math.max(5, Number(env.LIVE_CACHE_SEC) || 30) * 1000;
  const key = String(env.SEOUL_BUS_API_KEY || '').trim();
  // v2.7.0 서울시 버스 하루 호출 수(서비스별 — 지금까지는 서버가 켜진 뒤 누적 apiCalls만) · 외부 DB 날짜별 카운터(서버를 다시 켜도 그날 값 이어감)
  const today = () => seoulParts(new Date(clock())).dateKey;
  const daily = { date: today(), calls: Object.fromEntries(SEOUL_SVCS.map((k) => [k, 0])) };
  const rollDaily = () => { const d = today(); if (d !== daily.date) Object.assign(daily, { date: d, calls: Object.fromEntries(SEOUL_SVCS.map((k) => [k, 0])) }); };
  if (kv) for (const svc of SEOUL_SVCS) { const d = daily.date; kv.getNum(SEOUL_CNT(svc, d)).then((n) => { if (daily.date === d) daily.calls[svc] = Math.max(daily.calls[svc], n); }, () => {}); }
  function countCall(path) {
    const svc = String(path).split('/')[0];
    if (!SEOUL_SVCS.includes(svc)) return;
    rollDaily();
    daily.calls[svc] += 1;
    const d = daily.date;
    if (kv) kv.incr(SEOUL_CNT(svc, d), 2 * 86400).then((n) => { if (daily.date === d) daily.calls[svc] = Math.max(daily.calls[svc], n); }, () => {});
  }
  const stationCallsToday = () => { rollDaily(); return daily.calls.stationinfo; };
  // v2.7.0 환승 버스(서울시 정류장) 하루 몫 — SEOUL_BUS_MID_DAILY_CAP(비우면 100 · 0이면 끔) · 개수(health live.mid)
  const midBudget = createMidBudget({ cap: parseMidCap(env.SEOUL_BUS_MID_DAILY_CAP, SEOUL_BUS_MID_DEFAULT_CAP), kv, keyOf: SEOUL_MID_CNT, today, extraSkips: BUS_MID_SKIPS });
  const client = createSeoulClient({
    key, fetchImpl, baseUrl: env.SEOUL_BUS_BASE_URL || undefined, format: env.SEOUL_BUS_FORMAT === 'json' ? 'json' : 'xml',
    keyParam: env.SEOUL_BUS_KEY_PARAM || 'ServiceKey', timeoutMs: Number(env.SEOUL_BUS_TIMEOUT_MS) || 6000, onCall: countCall,
  });
  // 탑승 정류장 화면의 경유 정류소 캐시(기본 5분): 노선정보는 하루 한 번 갱신된다고 가이드에 적혀 있어 호출을 아낌
  const adapter = createSeoulAdapter({ client, cache, ttlMs, stationsTtlMs: Math.max(30, Number(env.ROUTE_CACHE_SEC) || 300) * 1000 });
  const mock = createMockProvider(env.MOCK_SCENARIO || 'jeongneung');
  const lastGood = new Map();  // 노선 설정 키 → { at, data }
  const active = new Map();    // 노선 설정 키 → { route, seenAt }
  const state = { provider: key ? 'seoul' : 'mock', reason: key ? null : 'no-key', lastOkAt: null, lastError: null, quotaUntil: 0 };
  const routeKey = (r) => `${r.no}|${r.boardArsId || ''}|${r.alightName || r.stop || ''}|${r.busRouteId || ''}`;

  async function fetchRoute(r) {
    try {
      const data = await adapter.routeLive(r);
      lastGood.set(routeKey(r), { at: clock(), data });
      state.lastOkAt = clock();
      return data;
    } catch (e) {
      const err = e instanceof SeoulApiError ? e : new SeoulApiError('api', e.message);
      if (err.kind === 'quota') state.quotaUntil = clock() + quotaCooldownMs; // 한도 초과면 한동안 호출을 멈춤
      if (err.kind !== 'config') state.lastError = { kind: err.kind, message: err.message, at: clock() };
      throw err;
    }
  }

  /** 노선 하나: 정상값 · 오래된 정상값(stale) · 오류 */
  async function resolve(r) {
    if (!key) return { r, err: new SeoulApiError('no-key', reasonText('no-key')) };
    const lg = lastGood.get(routeKey(r));
    const staleOk = lg && clock() - lg.at <= staleMaxMs;
    if (clock() < state.quotaUntil) return staleOk ? { r, data: lg.data, at: lg.at, stale: true } : { r, err: new SeoulApiError('quota', reasonText('quota')) };
    try { return { r, data: await fetchRoute(r), at: clock() }; } catch (err) {
      if (staleOk && err.kind !== 'config') return { r, data: lg.data, at: lg.at, stale: true, err };
      return { r, err };
    }
  }

  async function live(routes, nowDate = new Date()) {
    const used = (routes || []).filter((r) => r.enabled !== false);
    for (const r of used) active.set(routeKey(r), { route: r, seenAt: clock() });
    const results = await Promise.all(used.map(resolve));
    const updatedAt = new Date(clock()).toISOString();

    if (!results.some((x) => x.data)) {
      // 모든 노선이 실패 → 예시(모의) 데이터로 자동 폴백. 이유를 함께 알려 화면이 '예시 데이터'로 표시하게 함
      const reason = mainReason(results.map((x) => x.err?.kind)) || 'api';
      Object.assign(state, { provider: 'mock', reason });
      const m = await mock.live(used, nowDate);
      const errs = Object.fromEntries(results.map((x) => [x.r.id, x.err?.message]));
      return { ...m, routes: m.routes.map((r) => ({ ...r, source: 'mock', note: errs[r.id] || null })), source: 'mock', provider: 'mock', reason, reasonText: reasonText(reason), updatedAt };
    }

    const out = results.map(({ r, data, at, stale, err }) => {
      const usual = baseline.usual(r.id, nowDate);
      const usualMin = usual ?? r.usualMin;
      if (!data) {
        // 다른 노선은 실시간인데 이 노선만 실패 → 예시 값을 섞지 않고 '정보 없음'으로(대체 노선 비교가 틀어지지 않게)
        return withStatus({ ...r, usualMin, liveMin: null, source: 'seoul', error: err.message, errorKind: err.kind });
      }
      const liveMin = Math.round(data.trip.minutes);
      if (!stale) baseline.record(r.id, nowDate, liveMin); // '평소'는 오늘 값을 넣기 전에 읽어 둠(위)
      return withStatus({
        ...r, usualMin, liveMin, source: 'seoul', stale: Boolean(stale), ageSec: Math.round((clock() - at) / 1000),
        busRouteId: data.busRouteId, cause: data.cause?.text ?? null, causeDetail: data.cause,
        inVehicle: { minutes: Math.round(data.trip.minutes * 10) / 10, distM: Math.round(data.trip.distM), intermediateStops: data.trip.intermediateStops,
          board: data.board.name, alight: data.alight.name, slowest: { from: data.trip.slowest.from, to: data.trip.slowest.to, kmh: data.trip.slowest.kmh } },
        arrival: data.arrival ? { first: data.arrival.first, second: data.arrival.second, ended: data.arrival.ended } : null,
      });
    });
    // 전체 원인: 가장 많이 늦는 노선의 원인 / 정체 지도용 도로별 지연(서울시 값으로 추정)
    const delayed = out.filter((r) => r.delayMin >= 2 && r.cause).sort((a, b) => b.delayMin - a.delayMin);
    const roadDelays = {};
    for (const r of delayed) if (r.causeDetail?.road) roadDelays[r.causeDetail.road] = Math.max(roadDelays[r.causeDetail.road] || 0, r.delayMin);
    Object.assign(state, { provider: 'seoul', reason: null });
    return { routes: out, cause: delayed[0]?.cause ?? null, roadDelays, source: 'seoul', provider: 'seoul', partial: out.some((r) => r.liveMin == null), updatedAt };
  }

  // ── 탑승 정류장 하나 → 국민대행 노선(v0.4 화면) ──
  const scenario = env.MOCK_SCENARIO || 'jeongneung';
  const stopLastGood = new Map();   // arsId → { at, trips }
  const stopsSeen = new Map();      // arsId → 마지막 요청 시각(상태 표시용)
  const toErr = (e) => (e instanceof SeoulApiError ? e : new SeoulApiError('api', e.message));
  function noteError(err) {
    if (err.kind === 'quota') state.quotaUntil = clock() + quotaCooldownMs; // 한도 초과면 한동안 호출을 멈춤
    if (err.kind !== 'config') state.lastError = { kind: err.kind, message: err.message, at: clock() };
  }
  /** 정류장 검색은 예시로 대신할 수 없으므로 실패하면 이유와 함께 예외 */
  async function lookup(load) {
    if (!key) throw new SeoulApiError('no-key', '서버에 서울시 버스 API 키가 없어 정류장을 찾을 수 없어요');
    if (clock() < state.quotaUntil) throw new SeoulApiError('quota', '서울시 API 호출 한도를 넘어 잠시 정류장을 찾을 수 없어요');
    try { const r = await load(); state.lastOkAt = clock(); return r; } catch (e) { const err = toErr(e); noteError(err); throw err; }
  }

  /**
   * 탑승 정류장 → 국민대로 가는 노선별 실시간 도착·차내 시간·정체.
   * 실패하면 직전 정상값(3분 이내, 도착 예정은 흐른 시간만큼 줄임) → 그것도 없으면 예시 데이터(shared/transitModel.js)
   * @returns {Promise<{ trips, source:'seoul'|'mock', reason, reasonText, stale, ageSec, fetchedAt, error? }>}
   */
  async function stopTrips(arsId, nowDate = new Date()) {
    stopsSeen.set(arsId, clock());
    const fetchedAt = new Date(clock()).toISOString();
    const example = (reason, err) => {
      Object.assign(state, { provider: 'mock', reason });
      return { trips: mockTrips(seoulParts(nowDate).minutes, scenario), source: 'mock', reason, reasonText: reasonText(reason), stale: false, ageSec: 0, fetchedAt, error: err?.message ?? null };
    };
    const lg = stopLastGood.get(arsId);
    const staleOk = lg && clock() - lg.at <= staleMaxMs;
    const fromLast = (kind) => {
      const ageSec = (clock() - lg.at) / 1000;
      const trips = lg.trips.map((t) => ({ ...t, etasSec: t.etasSec.map((v) => v - ageSec).filter((v) => v > -20) }));
      return { trips, source: 'seoul', reason: kind, reasonText: reasonText(kind), stale: true, ageSec: Math.round(ageSec), fetchedAt };
    };
    if (!key) return example('no-key');
    if (clock() < state.quotaUntil) return staleOk ? fromLast('quota') : example('quota');
    try {
      const trips = await adapter.stopTrips(arsId);
      stopLastGood.set(arsId, { at: clock(), trips });
      Object.assign(state, { provider: 'seoul', reason: null, lastOkAt: clock() });
      return { trips, source: 'seoul', reason: null, reasonText: '', stale: false, ageSec: 0, fetchedAt };
    } catch (e) {
      const err = toErr(e);
      noteError(err);
      return staleOk ? fromLast(err.kind) : example(err.kind, err);
    }
  }

  /**
   * (환승 경로) 정류장 하나의 모든 노선 도착 예정 — 예시 데이터로 대신하지 않고 실패하면 예외(계산은 표준 대기 시간으로)
   * @returns {Promise<{ arrivals, source:'seoul', fetchedAt }>}
   */
  async function stopArrivals(arsId) {
    const arrivals = await lookup(() => adapter.stopArrivals(arsId));
    return { arrivals, source: 'seoul', fetchedAt: new Date(clock()).toISOString() };
  }

  /**
   * v2.7.0 환승 버스(서울시 정류장)의 정류장 도착 — midLive.js가 '출발했어요!' 뒤 · 탈 때 ±15분 · 한 곳일 때만 부름.
   *   60초 안에 받은 값은 다시 씀(환승 버스용 보관 · 사용자끼리 나눔) · 첫 · 마지막 버스가 30초 안에 받은 값이 있으면 그것(몫을 쓰지 않음) ·
   *   한도 초과로 쉬는 중 · 오늘 정류소정보조회가 보호선(800)에 닿음 · 하루 몫을 다 씀 → 부르지 않음(source 'cap') · 못 받은 결과도 60초 동안 다시 부르지 않음
   * @returns {Promise<{ source:'seoul'|'cap'|'off'|'nodata'|'error', reason?, arrivals, ageSec? }>}  arrivals의 도착 예정(초)은 ageSec 전 값
   */
  const cacheNow = typeof cache.now === 'function' ? cache.now : () => Date.now();
  const midCache = new Map(), midInflight = new Map(); // arsId → { at, value }
  async function stopArrivalsMid(arsId) {
    if (!key) return { source: 'off', reason: 'no-key', arrivals: [] };
    const own = midCache.get(arsId);
    if (own && clock() - own.at < MID_REUSE_SEC * 1000) return { ...own.value, ageSec: Math.max(0, (clock() - own.at) / 1000) };
    if (midInflight.has(arsId)) return midInflight.get(arsId);
    const hit = await adapter.peekArrivals(arsId).catch(() => null);
    if (hit) {
      const ageSec = Math.max(0, (cacheNow() - hit.at) / 1000);
      const value = { source: 'seoul', arrivals: hit.arrivals };
      midCache.set(arsId, { at: clock() - ageSec * 1000, value });
      return { ...value, ageSec };
    }
    if (clock() < state.quotaUntil) return { source: 'cap', reason: 'quota', arrivals: [] };
    if (stationCallsToday() >= SEOUL_BUS_MID_GUARD) return { source: 'cap', reason: 'guard', arrivals: [] };
    if (midBudget.over()) return { source: 'cap', reason: 'mid-cap', arrivals: [] };
    midBudget.take();
    const p = (async () => {
      let value;
      try {
        value = { source: 'seoul', arrivals: await adapter.fetchArrivals(arsId) };
        state.lastOkAt = clock();
      } catch (e) {
        const err = toErr(e);
        noteError(err);
        value = { source: err.kind === 'quota' ? 'cap' : err.kind === 'no-key' ? 'off' : 'error', reason: err.kind, arrivals: [] };
      }
      midCache.set(arsId, { at: clock(), value });
      if (midCache.size > 300) midCache.delete(midCache.keys().next().value);
      return { ...value, ageSec: 0 };
    })().finally(() => midInflight.delete(arsId));
    midInflight.set(arsId, p);
    return p;
  }

  // 30초마다 최근 15분 안에 요청된 노선을 미리 갱신 → 화면·스케줄러 요청은 캐시에서 바로 응답
  let timer = null;
  async function refreshActive() {
    if (!key || clock() < state.quotaUntil) return;
    for (const [k, v] of active) {
      if (clock() - v.seenAt > activeWindowMs) { active.delete(k); continue; }
      try { await fetchRoute(v.route); } catch { /* 다음 요청에서 폴백 처리 */ }
    }
  }
  if (background && key) { timer = setInterval(refreshActive, ttlMs); timer.unref?.(); }

  return {
    get name() { return state.provider; },
    live,
    refreshActive,
    stationsOf: (no, busRouteId) => adapter.stationsOf(no, busRouteId),
    stopTrips,
    stopArrivals,
    stopArrivalsMid, // v2.7.0 환승 버스(서울시 정류장)
    noteMid: midBudget.note, // v2.7.0 환승 버스 개수(midLive.js가 부름) — 개수만(정류장 · 노선 이름 없음)
    midCap: midBudget.cap, // v2.7.0 0이면 서울시 정류장 환승 버스 실시간 끔
    searchStops: (q) => lookup(() => adapter.searchStops(q)),
    nearStops: (lat, lon, radius = 400) => lookup(() => adapter.nearStops(lat, lon, radius)),
    health() {
      const quota = clock() < state.quotaUntil;
      const provider = !key || quota ? 'mock' : state.provider;
      const reason = !key ? 'no-key' : quota ? 'quota' : state.reason;
      return {
        provider, reason, reasonText: reasonText(reason), keyConfigured: Boolean(key), cache: cache.kind || 'memory', cacheSec: ttlMs / 1000,
        lastOkAt: state.lastOkAt && new Date(state.lastOkAt).toISOString(),
        lastError: state.lastError && { ...state.lastError, at: new Date(state.lastError.at).toISOString() },
        quotaUntil: quota ? new Date(state.quotaUntil).toISOString() : null,
        apiCalls: client.stats.calls, activeRoutes: active.size,
        activeStops: [...stopsSeen.values()].filter((t) => clock() - t <= activeWindowMs).length,
        // v2.7.0 오늘 호출 수(서비스별 — stationinfo 정류소정보조회 · busRouteInfo 노선정보조회) · 환승 버스(서울시 정류장) 몫 · 보호선
        callsToday: (rollDaily(), { ...daily.calls }),
        mid: { ...midBudget.health(), guardAt: SEOUL_BUS_MID_GUARD, guardReached: daily.calls.stationinfo >= SEOUL_BUS_MID_GUARD },
      };
    },
    stop() { clearInterval(timer); },
  };
}

/** 예전 이름 호환: 환경변수로 공급자 만들기 */
export function createProvider(env = process.env, opts = {}) {
  return createLiveService({ env, ...opts });
}
