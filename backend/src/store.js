// 사용자 저장소: 시간표 · 탑승 정류장 · 설정 · 푸시 구독 · 보낸 알림 기록 · 내 걸음 반영(도착 기록) · 출발 방식(환승 경로).
//   - 외부 DB(Upstash Redis): 환경변수 UPSTASH_REDIS_REST_URL · UPSTASH_REDIS_REST_TOKEN이 있으면.
//     서버가 시작할 때 전부 읽어 오고(store.ready), 바뀐 사용자만 0.3초 뒤 모아서 저장 → 서버가 잠들거나 다시 배포돼도 그대로
//   - 없으면 JSON 파일(DATA_FILE, 로컬 개발용). Render 무료 서버에서는 잠들거나 재시작하면 지워집니다.
//   화면 · 스케줄러는 메모리의 값을 바로 쓰고(동기), 저장만 뒤에서 합니다.
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_ROUTES } from '../../shared/transitModel.js';
import { DEFAULT_MARGIN_MIN, DEFAULT_NOTIFY_BEFORE_MIN } from '../../shared/departure.js';
import { DEFAULTS } from '../../shared/recommend.js';
import { ARRIVAL, emptyPersonal } from '../../shared/arrival.js';
import { createUpstash, upstashUsers } from './upstash.js';

const ARS_ID = /^\d{5}$/;
const cut = (v, n) => String(v ?? '').trim().slice(0, n);
/**
 * 노선 설정 정리·검증. boardArsId = 내 승차 정류장 번호(5자리, 정류소정보조회의 arsId), alightName = 학교 하차 정류장 이름
 * @throws {Error} boardArsId 형식이 틀리면
 */
export function cleanRoute(r, i = 0) {
  const board = cut(r.boardArsId, 10);
  if (board && !ARS_ID.test(board)) throw new Error(`${cut(r.no, 10) || i + 1}번 노선: 승차 정류장 번호는 숫자 5자리예요`);
  const seq = Array.isArray(r.corridorSeq) && r.corridorSeq.length === 2 && r.corridorSeq.every(Number.isFinite) ? r.corridorSeq.map(Number) : undefined;
  const no = cut(r.no, 10);
  return {
    id: cut(r.id, 20) || no || `r${i}`, no, type: cut(r.type, 6), gate: r.gate === '후문' ? '후문' : '정문', stop: cut(r.stop, 30),
    usualMin: Math.max(1, Math.min(180, Number(r.usualMin) || 10)), corridor: cut(r.corridor, 20), ...(seq ? { corridorSeq: seq } : {}),
    enabled: r.enabled !== false, boardArsId: board, alightName: cut(r.alightName || r.stop, 30),
    ...(/^\d{6,12}$/.test(cut(r.busRouteId, 12)) ? { busRouteId: cut(r.busRouteId, 12) } : {}),
  };
}

/** 새 사용자: 시간표는 비어 있고, 탑승 정류장 하나만 고르면 바로 계산됩니다. */
export const defaultUser = () => ({
  classes: [],
  stop: null,      // { arsId, name } — 탑승 정류장(v0.4 화면)
  prefs: { walkToStopMin: DEFAULTS.walkToStopMin, marginMin: DEFAULTS.marginMin, notify: true, notifyBeforeMin: DEFAULTS.notifyBeforeMin },
  // v0.3 노선별 설정 — /api/live?routes= 호환용(화면은 탑승 정류장 방식을 씀)
  routes: EXAMPLE_ROUTES.map((r, i) => cleanRoute(r, i)),
  primaryRouteId: '171',
  settings: { marginMin: DEFAULT_MARGIN_MIN, notifyBeforeMin: DEFAULT_NOTIFY_BEFORE_MIN },
  walkOverrides: {},
  push: [],        // Web Push 구독(기기별, 최대 5개) + 기기 정보 · 수신 확인 시각
  pushLog: [],     // 보낸 알림(테스트 · 출발 알림) 기록 — 서비스 워커가 '받았음'을 알리면 ackAt
  fired: {},       // `${dateKey}:${classId}`(환승 경로는 끝에 ':transit') → 보낸 알림 기록
  handoff: null,   // 홈 화면 앱으로 설정 이어받기 코드 { token, exp, usedAt }
  personal: emptyPersonal(), // 내 걸음 반영 { offsetMin(−5 ~ +15), samples, updatedAt } — '도착했어요!'로 배움
  arrivals: [],    // 최근 도착 기록(최대 20개) — 같은 날 같은 수업은 한 번만
  // v2.0 출발 방식: 'direct'(단일 정류장 직행) | 'transit'(출발지 환승 경로, ODsay에서 고른 경로를 그대로 저장)
  // v2.1 retry: 경로를 못 찾아 근처 국민대행 정류장으로 안내 중일 때 다시 찾을 출발지 { origin, reason, at }
  transit: { mode: 'direct', origin: null, route: null, savedAt: null, retry: null },
  // v2.2 '출발했어요!': 오늘 출발 기록 하나 { key(날짜:수업), at, departMin, routeKey } — 날짜 · 경로가 다르면 쓰지 않음(다음에 누르면 덮어씀)
  departure: null,
  updatedAt: 0,
});

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * 기록이 끝없이 커지지 않게: '보낸 알림' 기록은 가장 최근 날짜에서 3일 안의 것만 · 구독은 최근 5개 · 알림 로그는 최근 8개 · 도착 기록은 최근 20개
 * (서버 시계 대신 기록 안의 날짜를 기준으로 해서, 시계를 바꿔 끼우는 테스트 · FAKE_NOW에서도 같은 결과)
 */
export function tidyUser(u) {
  const days = Object.keys(u.fired || {}).map((k) => k.slice(0, 10)).filter((d) => DAY_KEY.test(d)).sort();
  if (days.length) {
    const cutoff = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) - 3 * 86400_000).toISOString().slice(0, 10);
    for (const k of Object.keys(u.fired)) { const d = k.slice(0, 10); if (DAY_KEY.test(d) && d < cutoff) delete u.fired[k]; }
  }
  if (Array.isArray(u.push) && u.push.length > 5) u.push = u.push.slice(-5);
  if (Array.isArray(u.pushLog) && u.pushLog.length > 8) u.pushLog = u.pushLog.slice(-8);
  if (Array.isArray(u.arrivals) && u.arrivals.length > ARRIVAL.keep) u.arrivals = u.arrivals.slice(-ARRIVAL.keep);
  return u;
}

/**
 * @param {string|null} file  JSON 파일 경로(외부 DB가 없을 때) · null이면 메모리만(테스트)
 * @param {object} [o]
 * @param {{ kind: string, loadAll(): Promise<object>, saveMany(entries): Promise<void> } | null} [o.remote]  외부 DB(upstashUsers)
 * @param {number} [o.flushMs]  저장을 모으는 시간  @param {number[]} [o.retryMs]  저장 실패 뒤 다시 시도 간격
 * @param {number} [o.readyWaitMs]  시작할 때 외부 DB를 기다리는 최대 시간(넘으면 일단 메모리로 열고 뒤에서 계속 읽기)
 */
export function createStore(file, { remote = null, log = console, clock = () => Date.now(), flushMs = 300, retryMs = [2000, 10000, 30000, 60000], loadRetryMs = 30000, readyWaitMs = 8000 } = {}) {
  let db = { users: {} };
  if (!remote && file && fs.existsSync(file)) { try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 깨진 파일이면 새로 시작 */ } }
  if (!db.users) db.users = {};
  const st = {
    kind: remote ? remote.kind || 'remote' : file ? 'file' : 'memory', loaded: !remote, loadedAt: null, savedAt: null, saves: 0,
    lastError: null, dirty: new Set(), saving: false, attempt: 0, timer: null, loadTimer: null,
  };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const errInfo = (e) => ({ kind: e?.kind || 'error', message: String(e?.message || e).slice(0, 200), at: clock() });

  // ── 파일 저장(로컬 개발) ──
  let fileTimer = null;
  const persistFile = () => {
    if (!file) return;
    clearTimeout(fileTimer);
    fileTimer = setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db, null, 1)); }, 200);
  };

  // ── 외부 DB 저장: 바뀐 사용자만 모아서, 실패하면 간격을 늘려 다시 ──
  function schedule(ms) {
    if (st.timer) return;
    st.timer = setTimeout(() => { st.timer = null; flush().catch(() => {}); }, ms);
    st.timer.unref?.();
  }
  async function flush() {
    if (!remote || !st.loaded || st.saving || !st.dirty.size) return;
    st.saving = true;
    const ids = [...st.dirty];
    st.dirty.clear();
    try {
      await remote.saveMany(ids.filter((id) => db.users[id]).map((id) => [id, db.users[id]]));
      st.savedAt = clock(); st.saves++; st.attempt = 0;
      if (st.lastError?.op === 'save') st.lastError = null;
    } catch (e) {
      for (const id of ids) st.dirty.add(id);
      st.lastError = { ...errInfo(e), op: 'save' };
      log.warn?.(`[store] 저장 실패: ${st.lastError.message}`);
      st.attempt++;
    } finally {
      st.saving = false;
      if (st.dirty.size) schedule(st.attempt ? retryMs[Math.min(st.attempt - 1, retryMs.length - 1)] : flushMs);
    }
  }
  function markDirty(id) {
    if (remote) { st.dirty.add(id); if (st.loaded) schedule(flushMs); } else persistFile();
  }

  // ── 시작할 때 외부 DB에서 전부 읽기. 실패하면 메모리로 열고 30초마다 다시 읽기 ──
  //    읽기 전에 바뀐 사용자(서버가 비었을 때 화면이 이 기기 값으로 되살린 경우 등)는 updatedAt이 더 새로우면 메모리 값을 남김
  async function load() {
    try {
      const all = await remote.loadAll();
      let merged = 0;
      for (const [id, u] of Object.entries(all)) {
        const cur = db.users[id];
        if (!cur || (u.updatedAt || 0) >= (cur.updatedAt || 0)) { db.users[id] = u; merged++; } else st.dirty.add(id);
      }
      st.loaded = true; st.loadedAt = clock();
      if (st.lastError?.op === 'load') st.lastError = null;
      log.info?.(`[store] 외부 DB에서 사용자 ${merged}명을 읽었어요`);
      if (st.dirty.size) schedule(flushMs);
    } catch (e) {
      st.lastError = { ...errInfo(e), op: 'load' };
      log.warn?.(`[store] 외부 DB 읽기 실패(${st.lastError.message}) — ${loadRetryMs / 1000}초 뒤 다시 시도`);
      st.loadTimer = setTimeout(() => { st.loadTimer = null; load(); }, loadRetryMs);
      st.loadTimer.unref?.();
    }
  }
  const loading = remote ? load() : Promise.resolve();
  const ready = Promise.race([loading, new Promise((r) => { const t = setTimeout(r, readyWaitMs); t.unref?.(); })]).then(() => undefined);

  return {
    /** 시작할 때 외부 DB 읽기가 끝날 때까지(최대 readyWaitMs) — 요청 · 스케줄러는 이걸 기다린 뒤 시작 */
    ready,
    user(id) {
      if (!db.users[id]) { db.users[id] = defaultUser(); if (!remote) persistFile(); } // 외부 DB에는 바뀔 때만 저장
      const u = db.users[id], d = defaultUser();
      // 예전 버전에서 만든 사용자: 빠진 항목만 기본값으로 채움
      for (const [k, v] of Object.entries(d)) if (u[k] === undefined) u[k] = v;
      u.prefs = { ...d.prefs, ...u.prefs };
      return u;
    },
    update(id, fn) {
      const u = this.user(id);
      fn(u);
      u.updatedAt = clock();
      tidyUser(u);
      markDirty(id);
      return u;
    },
    users() { return Object.entries(db.users); },
    /** 저장을 기다리는 것을 지금 저장(종료 · 테스트용) */
    async flush() { clearTimeout(st.timer); st.timer = null; await flush(); },
    /** /api/health용 — 주소 · 토큰은 싣지 않음 */
    info() {
      return {
        kind: st.kind, loaded: st.loaded, users: Object.keys(db.users).length, loadedAt: iso(st.loadedAt), savedAt: iso(st.savedAt),
        saves: st.saves, pending: st.dirty.size, lastError: st.lastError && { ...st.lastError, at: iso(st.lastError.at) },
      };
    },
    stop() { clearTimeout(st.timer); clearTimeout(st.loadTimer); clearTimeout(fileTimer); },
  };
}

/** 환경변수로 저장소 고르기: Upstash 주소 · 토큰이 둘 다 있으면 외부 DB, 아니면 파일(DATA_FILE) */
export function createStoreFromEnv(env = process.env, { fetchImpl, log = console, clock } = {}) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').trim(), token = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (url && token) {
    const client = createUpstash({ url, token, ...(fetchImpl ? { fetchImpl } : {}) });
    return createStore(null, { remote: upstashUsers(client, env.UPSTASH_USERS_KEY || 'kubusai:users'), log, ...(clock ? { clock } : {}) });
  }
  return createStore(env.DATA_FILE || './data/db.json', { log, ...(clock ? { clock } : {}) });
}
