// KU BUS AI 백엔드(Express). 실행: npm start  (.env는 .env.example 참고)
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanRoute, createStoreFromEnv } from './store.js';
import { createBaseline, createLiveService } from './transit/index.js';
import { createCacheFromEnv } from './transit/cache.js';
import { reasonText } from '../../shared/liveStatus.js';
import { createPusher, pushSummary, sendAndLog, upsertSubscription, validSubscription } from './push.js';
import { createScheduler } from './scheduler.js';
import { departedMinFor, planFor, walkTableFor } from './planner.js';
import { parseTimetableText } from '../../shared/parseTimetableText.js';
import { BUILDINGS, GATES, WALK_TABLE, DEFAULT_WALK_MIN } from '../../shared/campusData.js';
import { seoulParts, toHHMM, toMin } from '../../shared/time.js';
import { searchCourses } from '../../shared/courses.js';
import { loadCourses } from './courses.js';
import { createAccidentService } from './transit/seoulAccident.js';
import { createWeatherService } from './transit/kmaWeather.js';
import { createExplainService } from './transit/geminiExplain.js';
import { delayMinutes } from '../../shared/explain.js';
import { firstClassOf } from '../../shared/recommend.js';
import { arrivalKey, arrivalWindow, emptyPersonal, keepArrivals, recordArrival, undoArrival } from '../../shared/arrival.js';
import { createKvFromEnv } from './transit/kv.js';
import { createOdsayService } from './transit/odsay.js';
import { createSubwayService } from './transit/seoulSubway.js';
import { transitLive } from './transit/transitLive.js';
import { createNearKuFinder } from './transit/nearKu.js';
import { createOdsayWarmer } from './transit/odsayWarm.js';
import { NEARBY_REASONS, fallbackText, routeKey } from '../../shared/transitPlan.js';
import { SHARED_ID, idKind } from '../../shared/userId.js';
import { COARSE_DIGITS, coarseOrigin } from '../../shared/geoPrivacy.js';
import { createCoordMigration, userCoordStats } from './coords.js';
import { createRetention } from './retention.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const ARS_ID = /^\d{5}$/; // 서울시 정류소 번호(arsId)
const HANDOFF_MS = 2 * 3600_000; // 홈 화면 앱 이어받기 코드 유효 시간(한 번만 쓰임)
const DEPART_WINDOW_MIN = 240; // v2.2 '출발했어요!'를 받는 시간: 오늘 첫 수업 시작 4시간 전 ~ 시작 전(화면은 추천 출발 1시간 전부터 버튼을 보여 줌)
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
/**
 * v2.2.2 /api/health 'identity': 사용자 ID 종류별 개수(긴 새 ID · 예전 8자 · 그 밖)와 공용 'demo' 기록의 크기만 — ID 값 · 내용은 싣지 않음.
 *   배포 뒤 새 브라우저로 앱을 열면 users.long이 늘고, demoHeader(‘demo’로 온 요청 수)는 그대로 0이어야 함
 */
function identityHealth(store, st) {
  const users = { long: 0, short: 0, other: 0 };
  let demoUser = null;
  for (const [id, u] of store.users()) {
    const k = idKind(id);
    if (k === 'demo') demoUser = { classes: u.classes?.length || 0, push: u.push?.length || 0, saved: Boolean(u.updatedAt) };
    else users[k]++;
  }
  return { users, demoUser, demoHeader: st.demoHeader, demoHeaderLastAt: iso(st.demoHeaderLastAt) };
}
/**
 * '도착했어요!'를 누른 시각(ms): 휴대폰 시계가 서버와 2분 안이면 누른 시각(pressedAt) 그대로 —
 * 서버가 잠에서 깨는 동안 늦게 받거나 연결이 끊겨 나중에 다시 보내도 정확. 시계가 틀린 휴대폰이면
 * '누른 뒤 지난 시간'(sentAt − pressedAt, 최대 6시간)만 믿고 서버 시각에서 뺌. 둘 다 없으면 서버 시각
 */
export function arrivalTime(body, serverMs) {
  const p = Number(body?.pressedAt), s = Number(body?.sentAt);
  if (Number.isFinite(p) && Math.abs(p - serverMs) <= 2 * 60_000) return p;
  if (Number.isFinite(p) && Number.isFinite(s) && s >= p && s - p <= 6 * 3600_000) return serverMs - (s - p);
  return serverMs;
}
function validClass(c, i) {
  const day = Number(c.day), start = clean(c.start, 5), end = clean(c.end, 5);
  if (!clean(c.name, 40)) throw new Error(`${i + 1}번째 수업: 과목명이 없어요`);
  if (!(day >= 0 && day <= 5)) throw new Error(`${i + 1}번째 수업: 요일은 0(월)~5(토)`);
  if (!(toMin(end) > toMin(start))) throw new Error(`${i + 1}번째 수업: 시각을 확인하세요`);
  return {
    id: clean(c.id, 40) || `c${Date.now().toString(36)}${i}`, name: clean(c.name, 40), day, start, end, building: clean(c.building, 30), room: clean(c.room, 12), color: Number(c.color) || 0,
    // 수업 검색으로 넣은 강의: 같은 강의(요일 여러 개)를 묶는 번호와 교수·분반
    ...(c.courseId ? { courseId: clean(c.courseId, 40), professor: clean(c.professor, 20), section: clean(c.section, 4) } : {}),
  };
}

/**
 * 테스트에서 시계·공급자를 바꿔 끼울 수 있게 앱을 함수로 만듭니다. provider = createLiveService() 또는 createMockProvider()
 * incidents = createAccidentService() — 서울시 돌발정보(없으면 돌발정보 기능 꺼짐)
 * weather = createWeatherService() — 기상청 초단기실황(없으면 날씨 꺼짐)
 * explainer = createExplainService() — '왜 늦나요?' 한 줄(Gemini, 실패하면 기본 안내). 없으면 지연 분(delayMin)만 붙임
 * odsay = createOdsayService() — 출발지 환승 경로(ODsay, 하루 25건 · 30일 캐시). 없으면 경로 검색은 이유 + 근처 국민대행 정류장(nearKu)
 * subway = createSubwayService() — 서울시 실시간 지하철(환승 경로의 첫 지하철). 없으면 표준 대기 시간
 * nearKu = createNearKuFinder() — v2.1 경로를 못 찾을 때 출발지 400m 안의 국민대행 정류장(없으면 이 안내 없음)
 * warmer = createOdsayWarmer() — v2.1 밤에 주요 환승역 경로 미리 찾기(상태 표시용, 실행은 스케줄러)
 * deletedHoldMs — v2.2.5 '내 데이터 모두 삭제' 뒤 같은 사용자 번호의 쓰기 요청을 받지 않는 시간(기본 2분)
 */
export function createApp({ store, provider, pusher, now = () => new Date(), scheduler = null, courses = loadCourses(), incidents = null, weather = null, explainer = null, odsay = null, subway = null, nearKu = null, warmer = null, coords = null, retention = null, deletedHoldMs = 2 * 60_000 }) {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  // 데모용 사용자 식별: X-User-Id 헤더(실서비스는 학교 계정 로그인 등으로 교체)
  //   v2.2.2 점검용: 화면이 'demo'를 사용자 ID로 보낸 요청 수 — 예전 화면은 저장 공간이 막히면 모두 'demo'를 같이 썼고,
  //   새 화면은 보내지 않음(동작은 예전과 같고 세기만 함. 헤더 없는 요청 · 서비스 워커 요청은 세지 않음)
  const idStats = { demoHeader: 0, demoHeaderLastAt: null };
  app.use((req, res, next) => {
    const h = req.get('x-user-id');
    req.userId = clean(h || 'demo', 64);
    if (h != null && clean(h, 64) === SHARED_ID) { idStats.demoHeader++; idStats.demoHeaderLastAt = now().getTime(); }
    // v2.2.4 마지막 사용 기록: 이 사용자의 화면이 보낸 요청이 끝난 뒤(저장된 사용자만 · 12시간에 한 번) — 헤더 없는 요청(cron · 서비스 워커)은 세지 않음
    if (h != null && retention) res.on('finish', () => { try { retention.touch(req.userId, now().getTime()); } catch { /* 기록 실패는 응답과 무관 */ } });
    next();
  });
  // 외부 DB(Upstash)에서 사용자 기록을 다 읽기 전에는 /api 요청을 잠깐 기다리게 함(빈 기록으로 덮어쓰지 않게)
  app.use('/api', (_req, _res, next) => { Promise.resolve(store.ready).then(() => next(), () => next()); });
  // v2.2.5 방금 '내 데이터 모두 삭제'로 지운 사용자 번호: 잠깐(기본 2분) 이 번호로 오는 쓰기 요청은 받지 않음 —
  //   지우기 직전에 보낸 저장(설정 · 시간표 · 알림 구독)이 지운 뒤에 도착해 기록을 다시 만들지 않게.
  //   서버 메모리에만 두고 시간이 지나면 잊음(외부 DB에 남기지 않음) · 읽기는 그대로(빈 기록, 저장 안 함) · 지우기 재시도는 받음
  const justDeleted = new Map();
  app.use('/api', (req, res, next) => {
    if (!justDeleted.size || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const at = justDeleted.get(req.userId);
    if (at === undefined) return next();
    if (Date.now() - at > deletedHoldMs) { justDeleted.delete(req.userId); return next(); }
    if (req.method === 'DELETE' && req.path === '/me') return next();
    res.status(409).json({ error: '방금 지운 사용자 번호예요. 앱을 새로 열어 주세요.', kind: 'deleted' });
  });
  const upSince = new Date().toISOString();

  // 실시간 공급자 상태(seoul | mock + 폴백 이유)와 서버 푸시·스케줄러 상태
  app.get('/api/health', (_req, res) => {
    const live = provider.health ? provider.health() : { provider: provider.name, reason: provider.name === 'mock' ? 'demo' : null };
    const subscriptions = store.users().reduce((n, [, u]) => n + (u.push?.length || 0), 0);
    res.json({
      ok: true, provider: live.provider, reason: live.reason ?? null, reasonText: live.reasonText ?? reasonText(live.reason), live,
      push: { enabled: pusher.enabled, vapidConfigured: Boolean(pusher.publicKey), configError: pusher.configError || null, subscriptions },
      storage: store.info?.() ?? null,
      scheduler: scheduler?.status?.() ?? null,
      incidents: incidents?.health?.() ?? { keyConfigured: false },
      weather: weather?.health?.() ?? { keyConfigured: false },
      explain: explainer?.health?.() ?? { keyConfigured: false },
      odsay: odsay?.health ? { ...odsay.health(), warm: warmer?.health?.() ?? null } : { keyConfigured: false },
      seoulSubway: subway?.health?.() ?? { keyConfigured: false },
      nearKu: nearKu?.health?.() ?? null,
      identity: identityHealth(store, idStats),
      // v2.2.3 위치 저장 정밀도: GPS 출발지 수 · 아직 칸보다 정밀한 수(0이어야 함) · 예전 기록을 옮긴 결과(좌표 값은 싣지 않음)
      location: { digits: COARSE_DIGITS, users: userCoordStats(store), migration: coords?.health?.() ?? null },
      // v2.2.4 보관 기간(마지막 사용 후 90일 자동 삭제): 개수 · 시각만(사용자 ID 없음)
      retention: retention?.health?.() ?? null,
    });
  });
  app.get('/api/meta', (_req, res) => res.json({ buildings: BUILDINGS, walkTable: WALK_TABLE, defaultWalkMin: DEFAULT_WALK_MIN, gates: GATES }));
  app.get('/api/me', (req, res) => { const { push, fired, pushLog, handoff, ...u } = store.user(req.userId); res.json({ ...u, pushSubscriptions: push.length }); });
  // v2.2.5 '내 데이터 모두 삭제': 이 사용자의 서버 기록 전체(시간표 · 정류장 · 출발지 · 설정 · 알림 구독 · 알림/도착 기록)를 지움.
  //   · 사용자 번호(X-User-Id) 헤더가 있어야 하고, 여러 기기가 같이 쓰던 'demo'는 지우지 않음 · 본문에 확인 문구 { confirm: '삭제' } 필수
  //   · 외부 DB를 다 읽기 전에는 지우지 않음(아직 안 읽은 기록이 남을 수 있어서) · 외부 DB에서도 지워진 뒤에 성공으로 답함
  //     → 화면은 성공을 받은 뒤에만 이 기기 값을 지움. 실패하면 503(이 기기 값은 그대로, 다시 눌러 재시도 — 이미 없으면 그대로 성공)
  app.delete('/api/me', async (req, res) => {
    const h = req.get('x-user-id');
    if (h == null || !clean(h, 64)) return res.status(400).json({ error: '사용자 번호가 없어요', kind: 'no-user' });
    if (req.userId === SHARED_ID) return res.status(400).json({ error: "여러 기기가 같이 쓰던 기록('demo')이라 여기서 지울 수 없어요", kind: 'shared' });
    if (String(req.body?.confirm ?? '').normalize('NFC').trim() !== '삭제') return res.status(400).json({ error: "확인 문구('삭제')가 필요해요", kind: 'confirm' });
    if (store.info?.() && !store.info().loaded) return res.status(503).json({ error: '서버가 저장소를 아직 다 읽지 못했어요', kind: 'not-ready' });
    const existed = store.peek(req.userId) !== undefined;
    const removed = existed ? store.remove(req.userId) : false;
    if (existed && !removed) return res.status(500).json({ error: '이 서버 저장소에서는 기록을 지울 수 없어요', kind: 'unsupported' });
    for (let i = 0; i < 3 && store.removalPending?.(req.userId); i++) {
      await store.flush();
      if (store.removalPending?.(req.userId)) await new Promise((r) => setTimeout(r, 300));
    }
    if (store.removalPending?.(req.userId)) return res.status(503).json({ error: '외부 저장소에서 아직 지우지 못했어요', kind: 'pending' });
    const t = Date.now();
    for (const [id, at] of justDeleted) if (t - at > deletedHoldMs) justDeleted.delete(id);
    justDeleted.set(req.userId, t);
    res.json({ ok: true, removed });
  });
  // 서버 깨우기(cron-job.org가 10분마다 부름): Render 무료 서버는 15분 동안 접속이 없으면 잠들어 알림을 못 보냄
  app.get('/api/wake', (_req, res) => {
    const si = store.info?.() ?? {};
    res.json({ ok: true, now: now().toISOString(), upSince, storage: { kind: si.kind ?? null, loaded: si.loaded ?? null }, schedulerLastTickAt: scheduler?.status?.().lastTickAt ?? null });
  });

  // 홈 화면 앱으로 설정 이어받기: 아이폰 홈 화면 앱은 Safari와 저장 공간이 따로라, 한 번만 쓰는 코드로 같은 사용자를 이어 줌
  app.post('/api/me/handoff', (req, res) => {
    const t = now().getTime(), cur = store.user(req.userId).handoff;
    if (cur?.token && !cur.usedAt && cur.exp - t > 30 * 60_000) return res.json({ token: cur.token, expiresAt: iso(cur.exp) });
    const token = crypto.randomBytes(9).toString('base64url');
    store.update(req.userId, (u) => { u.handoff = { token, exp: t + HANDOFF_MS, usedAt: null }; });
    res.json({ token, expiresAt: iso(t + HANDOFF_MS) });
  });
  app.post('/api/handoff/claim', (req, res) => {
    const token = clean(req.body?.token, 40);
    if (!/^[\w-]{8,40}$/.test(token)) return res.status(400).json({ error: '이어받기 코드 형식이 달라요' });
    const hit = store.users().find(([, u]) => u.handoff?.token === token);
    if (!hit) return res.status(404).json({ error: '이어받기 코드를 찾지 못했어요' });
    const [id, u] = hit, t = now().getTime();
    if (u.handoff.usedAt) return res.status(410).json({ error: '이미 쓴 이어받기 코드예요' });
    if (u.handoff.exp < t) return res.status(410).json({ error: '이어받기 코드 시간이 지났어요' });
    store.update(id, (x) => { x.handoff = { ...x.handoff, usedAt: t }; });
    res.json({ ok: true, userId: id, hasData: Boolean(u.stop || u.classes.length) });
  });

  app.put('/api/me/timetable', (req, res) => {
    try {
      const classes = (req.body?.classes || []).map(validClass);
      store.update(req.userId, (u) => { u.classes = classes; u.fired = {}; });
      res.json({ ok: true, count: classes.length });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/me/timetable/import-text', (req, res) => {
    const parsed = parseTimetableText(clean(req.body?.text, 5000));
    const ok = parsed.filter((e) => e.ok).map((e, i) => validClass(e, i));
    if (req.body?.apply) store.update(req.userId, (u) => { u.classes = req.body.replace ? ok : [...u.classes, ...ok]; u.fired = {}; });
    res.json({ parsed, applied: Boolean(req.body?.apply), count: ok.length });
  });
  // 탑승 정류장·출발 계산 설정(v0.4 화면)
  app.patch('/api/me', (req, res) => {
    const b = req.body || {};
    if (b.stop && !ARS_ID.test(clean(b.stop.arsId, 10))) return res.status(400).json({ error: '정류장 번호(arsId)는 숫자 5자리예요' });
    store.update(req.userId, (u) => {
      if (b.stop === null) u.stop = null;
      else if (b.stop?.arsId) {
        const next = { arsId: clean(b.stop.arsId, 10), name: clean(b.stop.name, 40) };
        if (next.arsId !== u.stop?.arsId) u.fired = {};
        u.stop = next;
      }
      const p = b.prefs || {};
      if (Number.isFinite(p.walkToStopMin)) u.prefs.walkToStopMin = Math.max(0, Math.min(30, p.walkToStopMin));
      if (Number.isFinite(p.marginMin)) u.prefs.marginMin = Math.max(0, Math.min(30, p.marginMin));
      if (Number.isFinite(p.notifyBeforeMin)) u.prefs.notifyBeforeMin = Math.max(1, Math.min(60, p.notifyBeforeMin));
      if (typeof p.notify === 'boolean') u.prefs.notify = p.notify;
      if (b.walkOverrides && typeof b.walkOverrides === 'object') u.walkOverrides = b.walkOverrides;
    });
    res.json({ ok: true });
  });

  // ── '도착했어요!': 오늘 첫 수업 도착 기록 → 내 걸음 반영(EMA, shared/arrival.js) — 같은 날 같은 수업은 한 번만 ──
  //   버튼 시간(수업 시작 30분 전 ~ 15분 뒤)과 '오늘 첫 수업'은 서버 시각으로 다시 확인. 결과는 사용자 기록(외부 DB)에 저장
  const personalOf = (u) => ({ personal: u.personal, arrivals: u.arrivals });
  app.post('/api/me/arrival', (req, res) => {
    const at = arrivalTime(req.body, now().getTime()), u = store.user(req.userId), p = seoulParts(new Date(at));
    const cls = p.weekday < 5 ? firstClassOf(u.classes, p.weekday) : null;
    if (!cls) return res.status(422).json({ error: '오늘은 등교할 수업이 없어요', kind: 'no-class', ...personalOf(u) });
    const want = clean(req.body?.classId, 40);
    if (want && want !== cls.id) return res.status(422).json({ error: '오늘 첫 수업이 바뀌었어요. 화면을 새로 고친 뒤 다시 눌러 주세요', kind: 'class-changed', ...personalOf(u) });
    const key = arrivalKey(p.dateKey, cls), old = u.arrivals.find((a) => a.key === key);
    if (old) return res.status(409).json({ error: '오늘 이 수업은 이미 도착을 기록했어요', kind: 'already', record: old, ...personalOf(u) });
    const win = arrivalWindow(cls, p.minutes);
    if (!win.canRecord) {
      return res.status(422).json({ error: `도착 기록은 ${toHHMM(win.openMin)} ~ ${toHHMM(win.closeMin)}(수업 시작 30분 전 ~ 15분 뒤)에만 할 수 있어요`, kind: 'outside-window', ...personalOf(u) });
    }
    let out = null;
    store.update(req.userId, (x) => {
      out = recordArrival(x.personal, { key, dateKey: p.dateKey, cls, arriveMin: p.minutes, at: new Date(at).toISOString() });
      x.personal = out.personal;
      x.arrivals = keepArrivals([...(x.arrivals || []), out.record]);
    });
    res.json({ ok: true, record: out.record, ...personalOf(store.user(req.userId)) });
  });
  // 잘못 누른 오늘 기록 되돌리기(가장 최근 기록만 → 그 앞 보정값으로)
  app.post('/api/me/arrival/undo', (req, res) => {
    const key = clean(req.body?.key, 80), u = store.user(req.userId);
    if (!key.startsWith(`${seoulParts(now()).dateKey}:`)) return res.status(409).json({ error: '오늘 기록만 되돌릴 수 있어요', kind: 'not-today', ...personalOf(u) });
    const r = undoArrival(u.personal, u.arrivals, key, now().toISOString());
    if (!r) return res.status(404).json({ error: '되돌릴 기록을 찾지 못했어요', kind: 'not-found', ...personalOf(u) });
    store.update(req.userId, (x) => { x.personal = r.personal; x.arrivals = r.arrivals; });
    res.json({ ok: true, removed: r.removed, ...personalOf(store.user(req.userId)) });
  });
  // 내 걸음 반영 처음부터(보정 0 · 도착 기록 지움)
  app.post('/api/me/personal/reset', (req, res) => {
    store.update(req.userId, (x) => { x.personal = emptyPersonal(); x.arrivals = []; });
    res.json({ ok: true, ...personalOf(store.user(req.userId)) });
  });

  // ── v2.2 '출발했어요!': 환승 경로로 안내 중인 날, 누른 시각을 오늘 출발 시각으로(하나만 저장) ──
  //   → 화면 · 알림 계산이 '지금 출발'로 다시 밀지 않고 그 시각 기준으로 끝까지 따라감 · 그 수업의 출발 알림은 그만(planner.js)
  //   오늘 첫 수업 · 저장한 환승 경로 · 시간(수업 시작 4시간 전 ~ 시작 전)은 서버 시각으로 다시 확인. 누른 시각은 도착 기록과 같은 규칙(arrivalTime)
  const departureOf = (u) => ({ departure: u.departure || null });
  app.post('/api/me/departure', (req, res) => {
    const at = arrivalTime(req.body, now().getTime()), u = store.user(req.userId), p = seoulParts(new Date(at));
    const cls = p.weekday < 5 ? firstClassOf(u.classes, p.weekday) : null;
    if (!cls) return res.status(422).json({ error: '오늘은 등교할 수업이 없어요', kind: 'no-class', ...departureOf(u) });
    const want = clean(req.body?.classId, 40);
    if (want && want !== cls.id) return res.status(422).json({ error: '오늘 첫 수업이 바뀌었어요. 화면을 새로 고친 뒤 다시 눌러 주세요', kind: 'class-changed', ...departureOf(u) });
    const route = u.transit?.mode === 'transit' ? u.transit.route : null;
    if (!route?.legs?.length) return res.status(422).json({ error: '환승 경로로 안내 중일 때만 출발을 기록할 수 있어요', kind: 'no-route', ...departureOf(u) });
    const rk = routeKey(route), wantRk = clean(req.body?.routeKey, 400);
    if (wantRk && wantRk !== rk) return res.status(409).json({ error: '저장한 환승 경로가 바뀌었어요. 화면을 새로 고친 뒤 다시 눌러 주세요', kind: 'route-changed', ...departureOf(u) });
    const start = toMin(cls.start);
    if (!(p.minutes >= start - DEPART_WINDOW_MIN && p.minutes < start)) {
      return res.status(422).json({ error: `출발 기록은 ${toHHMM(Math.max(0, start - DEPART_WINDOW_MIN))} ~ ${cls.start}(수업 시작 전)에만 할 수 있어요`, kind: 'outside-window', ...departureOf(u) });
    }
    const key = arrivalKey(p.dateKey, cls), old = u.departure;
    if (old?.key === key && old.routeKey === rk) return res.json({ ok: true, already: true, ...departureOf(u) }); // 같은 누름을 다시 보냄(연결 끊김) → 처음 기록 그대로
    store.update(req.userId, (x) => { x.departure = { key, at: new Date(at).toISOString(), departMin: Math.round(p.minutes * 1000) / 1000, routeKey: rk }; });
    res.json({ ok: true, ...departureOf(store.user(req.userId)) });
  });
  // 잘못 누른 출발 기록 지우기 → 누르기 전처럼 다시 계산 · 알림
  app.post('/api/me/departure/undo', (req, res) => {
    const key = clean(req.body?.key, 80), u = store.user(req.userId);
    if (!u.departure || u.departure.key !== key) return res.status(404).json({ error: '지울 출발 기록을 찾지 못했어요', kind: 'not-found', ...departureOf(u) });
    store.update(req.userId, (x) => { x.departure = null; });
    res.json({ ok: true, departure: null });
  });

  // ── v2.0 출발지 환승 경로: ODsay 추천 경로(최대 3개) 고르기 · 저장 · 실시간(지하철 · 버스) ──
  //   검색은 오류를 내지 않고 { ok:false, fallback:'direct', reason, message }로 답함
  //   v2.1: 한도 초과 · ODsay 오류 때 30~90일 된 예전 경로가 있으면 { ok:true, stale:true, ageDays }(odsay.js),
  //         그것도 없으면 출발지 400m 안의 국민대행 정류장(nearby: { ok, stops }) — 화면이 가까운 곳으로 직행 안내
  app.post('/api/transit/search', async (req, res) => {
    const b = req.body || {};
    const lat = Number(b.lat), lon = Number(b.lon);
    const r = odsay
      ? await odsay.search({ lat, lon, name: clean(b.name, 40), kind: b.kind === 'gps' ? 'gps' : 'stop', arsId: clean(b.arsId, 10) })
      : { ok: false, fallback: 'direct', reason: 'no-key', message: fallbackText('no-key') };
    if (!r.ok && nearKu && NEARBY_REASONS.includes(r.reason)) r.nearby = await nearKu.find(lat, lon).catch((e) => ({ ok: false, reason: e?.kind || 'api', stops: [] }));
    res.json(r);
  });
  // 출발 방식 바꾸기({ mode }) · 고른 경로 저장({ searchId, pathId } — 서버에 남아 있는 검색 결과에서 그대로 복사) · 지우기({ clear:true })
  app.post('/api/me/transit', async (req, res) => {
    const b = req.body || {};
    if (b.searchId) {
      const hit = odsay ? await odsay.byId(clean(b.searchId, 120)) : null;
      const route = hit?.paths?.find((p) => p.id === clean(b.pathId, 8));
      if (!route) return res.status(404).json({ error: '검색 결과가 만료됐어요. 출발지를 다시 검색해 주세요' });
      // v2.2.3 GPS 출발지는 약 100m 칸으로 저장(예전에 정밀하게 저장된 검색 결과를 골라도)
      store.update(req.userId, (u) => { u.transit = { mode: 'transit', origin: coarseOrigin(hit.origin), route, savedAt: now().toISOString() }; });
      return res.json({ ok: true, transit: store.user(req.userId).transit });
    }
    // v2.1 경로를 못 찾아 근처 국민대행 정류장으로 직행 안내: 정류장 · 걷는 시간을 저장하고, 다시 찾을 출발지를 기억(retry)
    if (b.fallbackStop) {
      const s = b.fallbackStop, arsId = clean(s.arsId, 10);
      if (!ARS_ID.test(arsId)) return res.status(400).json({ error: '정류장 번호(arsId)는 숫자 5자리예요' });
      const o = b.origin || {}, olat = Number(o.lat), olon = Number(o.lon);
      const origin = Number.isFinite(olat) && Number.isFinite(olon) ? coarseOrigin({ name: clean(o.name, 40) || '출발지', lat: olat, lon: olon, kind: o.kind === 'gps' ? 'gps' : 'stop', arsId: ARS_ID.test(clean(o.arsId, 10)) ? clean(o.arsId, 10) : '' }) : null; // v2.2.3 GPS면 약 100m 칸
      const walk = Number(s.walkMin);
      store.update(req.userId, (u) => {
        if (u.stop?.arsId !== arsId) u.fired = {};
        u.stop = { arsId, name: clean(s.name, 40) || arsId };
        if (Number.isFinite(walk)) u.prefs.walkToStopMin = Math.max(0, Math.min(30, Math.round(walk)));
        u.transit = { ...(u.transit || {}), mode: 'direct', retry: origin ? { origin, reason: clean(b.reason, 20) || null, at: now().toISOString() } : null };
      });
      const u = store.user(req.userId);
      return res.json({ ok: true, transit: u.transit, stop: u.stop, prefs: u.prefs });
    }
    if (b.clear === true) { // '처음 상태로 되돌리기': 고른 경로까지 지우고 직행으로
      store.update(req.userId, (u) => { u.transit = { mode: 'direct', origin: null, route: null, savedAt: null, retry: null }; });
      return res.json({ ok: true, transit: store.user(req.userId).transit });
    }
    if (b.mode === 'direct' || b.mode === 'transit') {
      store.update(req.userId, (u) => { u.transit = { ...u.transit, mode: b.mode, retry: null }; }); // 스위치로 직접 고르면 '경로 다시 찾기'는 끝
      return res.json({ ok: true, transit: store.user(req.userId).transit });
    }
    res.status(400).json({ error: 'mode(direct · transit) 또는 searchId · pathId가 필요해요' });
  });
  // 저장한 경로의 실시간 재료(화면이 30초마다): 첫 탑승(지하철은 출발 30분 전부터) · 마지막 국민대행 버스
  app.get('/api/transit/live', async (req, res) => {
    const u = store.user(req.userId), route = u.transit?.route;
    if (!route) return res.status(404).json({ error: '저장한 환승 경로가 없어요' });
    const p = seoulParts(now()), cls = p.weekday < 5 ? firstClassOf(u.classes, p.weekday) : null;
    try {
      // v2.1 화면 요청에는 경로 주변 돌발정보 · 날씨 · 마지막 국민대행 버스의 '왜 늦나요?'까지(직행과 같은 기준)
      res.json(await transitLive({ route, provider, subway, nowDate: now(), cls, walkTable: walkTableFor(u), marginMin: u.prefs.marginMin, personalOffsetMin: u.personal?.offsetMin || 0, force: req.query.force === '1', extras: { incidents, weather, explainer },
        departedMin: departedMinFor(u, p.dateKey, cls) })); // v2.2 '출발했어요!'를 눌렀으면 그 시각 기준
    } catch (e) { res.status(502).json({ error: `실시간 정보를 가져오지 못했어요: ${e.message}` }); }
  });

  // 수업 검색(시간표 탭): courses.json에서 과목명·교수명·과목번호로 찾기
  app.get('/api/courses/meta', (_req, res) => res.json(courses.meta));
  app.get('/api/courses', (req, res) => {
    if (!courses.meta.available) return res.status(503).json({ error: '강의 목록(courses.json)이 아직 없어요. tools/fetch_courses.py로 만들어 서버에 올려 주세요.' });
    const q = clean(req.query.q, 40);
    if (!q) return res.status(400).json({ error: '검색어를 입력하세요' });
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 30));
    res.json({ courses: searchCourses(courses.courses, q, { limit }), meta: courses.meta });
  });

  // 탑승 정류장 고르기: 이름 검색 / 내 주변 (서울시 정류소정보조회)
  const lookupError = (res, e) => res.status(['no-key', 'quota', 'auth'].includes(e.kind) ? 503 : 502).json({ error: e.message, kind: e.kind || 'api' });
  app.get('/api/stops', async (req, res) => {
    const q = clean(req.query.q, 30);
    if (q.length < 2) return res.status(400).json({ error: '정류장 이름을 두 글자 이상 입력하세요' });
    try { res.json({ stops: (await provider.searchStops(q)).slice(0, 30) }); } catch (e) { lookupError(res, e); }
  });
  app.get('/api/stops/near', async (req, res) => {
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ error: '위치(lat, lon)가 필요해요' });
    try { res.json({ stops: (await provider.nearStops(lat, lon, 400)).slice(0, 20) }); } catch (e) { lookupError(res, e); }
  });
  // 탑승 정류장 → 국민대행 노선별 실시간 도착·차내 시간·정체(화면이 20초마다 호출). 실패하면 직전 값 또는 예시 데이터 + 이유
  // + 경로 주변 서울시 돌발정보(incidents). 버스가 예시 데이터면 예시 돌발정보(source 'mock'), 키가 없으면 source 'off'
  // + 국민대 격자 지금 날씨(weather, 기상청 초단기실황). 실패하면 source 'error'로 알리고 날씨만 빠짐
  // + 노선마다 지연 분(delayMin, 서버 계산) · 막힐 때(보통 · 혼잡) '왜 늦나요?' 한 줄(explain: gemini | rule | example, 근거 facts)
  app.get('/api/stops/:arsId/trips', async (req, res) => {
    const arsId = clean(req.params.arsId, 10);
    if (!ARS_ID.test(arsId)) return res.status(400).json({ error: '정류장 번호(arsId)는 숫자 5자리예요' });
    let r;
    try { r = await provider.stopTrips(arsId, now()); } catch (e) { return res.status(502).json({ error: `실시간 정보를 가져오지 못했어요: ${e.message}` }); }
    const example = r.source === 'mock';
    const [inc, wx] = await Promise.all([
      incidents ? incidents.forTrips(r.trips, now(), { example }) : { source: 'off', reason: 'no-service', items: [] },
      weather ? weather.forView(now(), { example }).catch(() => ({ source: 'error', reason: 'api' })) : { source: 'off', reason: 'no-service' },
    ]);
    const plain = () => (r.trips || []).map((t) => ({ ...t, delayMin: delayMinutes(t) }));
    const trips = explainer ? await explainer.forTrips(r.trips, { incidents: inc, weather: wx, example }).catch(plain) : plain();
    res.json({ ...r, trips, incidents: inc, weather: wx });
  });
  // AI 설명 확인용: 예시 사실(실시간 아님)로 Gemini에 한 번 물어본 결과. 같은 결과는 5분 캐시(키는 나오지 않음)
  app.get('/api/explain/test', async (_req, res) => {
    if (!explainer) return res.json({ example: true, result: { source: 'off', reason: 'no-service' } });
    try { res.json(await explainer.test()); } catch (e) { res.json({ example: true, result: { source: 'error', reason: 'api', message: e.message } }); }
  });
  // 날씨 확인용: 국민대 격자(nx, ny) · 지금 강수형태 · 1시간 강수량 · 받은 항목 원문(raw). 응답 형식 확인에 씁니다(인증키는 나오지 않음)
  app.get('/api/weather', async (_req, res) => {
    if (!weather) return res.json({ source: 'off', reason: 'no-service' });
    try { res.json(await weather.inspect(now())); } catch (e) { res.json({ source: 'error', reason: 'api', message: e.message }); }
  });

  // v0.3 노선별 설정(/api/live 호환)
  app.patch('/api/me/settings', (req, res) => {
    const b = req.body || {};
    store.update(req.userId, (u) => {
      if (Number.isFinite(b.marginMin)) u.settings.marginMin = Math.max(0, Math.min(30, b.marginMin));
      if (Number.isFinite(b.notifyBeforeMin)) u.settings.notifyBeforeMin = Math.max(1, Math.min(60, b.notifyBeforeMin));
      if (b.primaryRouteId && u.routes.some((r) => r.id === b.primaryRouteId)) u.primaryRouteId = b.primaryRouteId;
      if (b.walkOverrides && typeof b.walkOverrides === 'object') u.walkOverrides = b.walkOverrides;
    });
    if (Array.isArray(b.routes)) {
      let routes;
      try { routes = b.routes.slice(0, 8).map(cleanRoute); } catch (e) { return res.status(400).json({ error: e.message }); }
      store.update(req.userId, (u) => {
        u.routes = routes;
        if (!routes.some((r) => r.id === u.primaryRouteId) && routes[0]) u.primaryRouteId = routes[0].id;
      });
    }
    res.json({ ok: true });
  });

  // 노선 경유 정류장(설정 화면에서 승차 정류장 고르기) — 서울시 노선정보조회 getStaionByRoute
  app.get('/api/routes/:no/stations', async (req, res) => {
    if (!provider.stationsOf) return res.status(503).json({ error: '예시 데이터 모드에서는 정류장 목록을 불러올 수 없어요', kind: 'no-key' });
    try {
      const { busRouteId, stations } = await provider.stationsOf(clean(req.params.no, 10), clean(req.query.busRouteId, 12) || undefined);
      res.json({ busRouteId, stations: stations.map((s) => ({ seq: s.seq, arsId: s.arsId, name: s.name, direction: s.direction, turn: s.turn })) });
    } catch (e) {
      const status = e.kind === 'no-key' || e.kind === 'quota' ? 503 : e.kind === 'config' ? 404 : 502;
      res.status(status).json({ error: e.message, kind: e.kind || 'api' });
    }
  });

  // 노선별 실시간 소요시간(프런트엔드 useLiveRoutes가 30초마다 호출)
  app.get('/api/live', async (req, res) => {
    const u = store.user(req.userId), ids = String(req.query.routes || '').split(',').filter(Boolean);
    const routes = u.routes.filter((r) => !ids.length || ids.includes(r.id));
    try { res.json({ ...(await provider.live(routes, now())), updatedAt: now().toISOString() }); }
    catch (e) { res.status(502).json({ error: `실시간 정보를 가져오지 못했어요: ${e.message}` }); }
  });
  // 오늘 추천(서버 계산, 화면과 같은 shared/recommend.js) + 지금 보낼 알림
  app.get('/api/plan', async (req, res) => {
    try {
      const { now: n, rec, live, alarms, mockData, arrived, mode } = await planFor(store.user(req.userId), provider, now(), { subway });
      res.json({ now: { ...n, hhmm: toHHMM(n.minutes) }, mode, source: live?.source ?? null, reason: live?.reason ?? null, reasonText: live?.reasonText ?? '', stale: Boolean(live?.stale), mockData, rec, trips: live?.trips ?? [], transit: mode === 'transit' ? live : undefined, alarmsDue: alarms, arrived });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Web Push: 구독(앱을 열 때마다 확인 · 자동 재등록) · 상태 · 테스트 알림 · 수신 확인 ──
  app.get('/api/push/key', (_req, res) => res.json({ publicKey: pusher.publicKey, enabled: pusher.enabled, configError: pusher.configError || null }));
  const endpointOf = (req) => (typeof req.body?.endpoint === 'string' ? req.body.endpoint.slice(0, 1000) : null);
  app.post('/api/push/subscribe', (req, res) => {
    const s = req.body?.subscription;
    if (!validSubscription(s)) return res.status(400).json({ error: '구독 정보가 올바르지 않아요' });
    let known = false;
    store.update(req.userId, (u) => { ({ known } = upsertSubscription(u, s, { device: clean(req.body?.device, 20), standalone: req.body?.standalone, now: now().getTime() })); });
    const u = store.user(req.userId);
    res.json({ ok: true, known, count: u.push.length, push: pushSummary(u, s.endpoint) });
  });
  app.post('/api/push/unsubscribe', (req, res) => {
    const ep = endpointOf(req);
    if (ep) store.update(req.userId, (u) => { u.push = u.push.filter((x) => x.endpoint !== ep); });
    res.json({ ok: true, count: store.user(req.userId).push.length });
  });
  app.post('/api/push/status', (req, res) => {
    const ep = endpointOf(req), u = store.user(req.userId);
    res.json({ enabled: pusher.enabled, known: Boolean(ep && u.push.some((x) => x.endpoint === ep)), ...pushSummary(u, ep) });
  });
  // 테스트 알림: 이 기기(endpoint)로만, 없으면 이 사용자의 모든 기기로. 10초에 한 번
  const lastTest = new Map();
  app.post('/api/push/test', async (req, res) => {
    if (!pusher.enabled) return res.status(503).json({ error: pusher.configError || '서버에 VAPID 키가 없어 알림을 보낼 수 없어요', kind: 'no-vapid' });
    const ep = endpointOf(req), u = store.user(req.userId);
    const subs = ep ? u.push.filter((x) => x.endpoint === ep) : u.push;
    if (!subs.length) return res.status(404).json({ error: ep ? '이 기기의 알림 구독을 서버에서 찾지 못했어요. 알림을 다시 켜 주세요' : '알림을 켠 기기가 없어요', kind: 'no-subscription' });
    const t = now().getTime();
    if (t - (lastTest.get(req.userId) || 0) < 10_000) return res.status(429).json({ error: '10초 뒤에 다시 보내 주세요', kind: 'rate' });
    lastTest.set(req.userId, t);
    const hhmm = toHHMM(Math.floor(seoulParts(now()).minutes));
    const r = await sendAndLog(store, req.userId, pusher, subs, {
      title: 'KU BUS AI 테스트 알림', body: `이 알림이 보이면 성공이에요(${hhmm} 보냄). 앱으로 돌아가면 '수신 확인됨'으로 바뀌어요.`, tag: 'kubus-test', url: '/#settings',
    }, { kind: 'test', now: t, ttl: 120 });
    res.status(r.sent ? 200 : 502).json({ ok: r.sent > 0, ...r, ...(r.sent ? {} : { error: `알림 서버가 받지 않았어요(${r.failed.map((f) => f.status || f.message).join(', ')})` }), push: pushSummary(store.user(req.userId), ep) });
  });
  // 서비스 워커가 알림을 받아 띄우면 부름(사용자 헤더 없이 알림 번호로 찾음)
  app.post('/api/push/ack', (req, res) => {
    const id = clean(req.body?.id, 40), ep = endpointOf(req);
    if (!/^[\w-]{6,40}$/.test(id)) return res.status(400).json({ error: '알림 번호 형식이 달라요' });
    const hit = store.users().find(([, u]) => (u.pushLog || []).some((e) => e.id === id));
    if (!hit) return res.status(404).json({ error: '알림 기록을 찾지 못했어요' });
    const t = now().getTime();
    store.update(hit[0], (u) => {
      const e = u.pushLog.find((x) => x.id === id);
      if (e && !e.ackAt) e.ackAt = t;
      if (hit[0] !== SHARED_ID) u.lastSeen = t; // v2.2.4 휴대폰이 알림을 받았다고 알림 = 사용
      const s = u.push.find((x) => x.endpoint === (ep || e?.to));
      if (s) s.ackAt = t;
    });
    res.json({ ok: true });
  });
  // 브라우저가 구독을 바꿨을 때(pushsubscriptionchange) 서비스 워커가 새 구독을 알려 줌
  app.post('/api/push/rotate', (req, res) => {
    const old = typeof req.body?.oldEndpoint === 'string' ? req.body.oldEndpoint : '', s = req.body?.subscription;
    if (!validSubscription(s)) return res.status(400).json({ error: '구독 정보가 올바르지 않아요' });
    const hit = old && store.users().find(([, u]) => u.push.some((x) => x.endpoint === old));
    if (!hit) return res.status(404).json({ error: '예전 구독을 찾지 못했어요' });
    store.update(hit[0], (u) => {
      const prev = u.push.find((x) => x.endpoint === old);
      u.push = u.push.filter((x) => x.endpoint !== old);
      upsertSubscription(u, s, { device: prev?.device, standalone: prev?.standalone, now: now().getTime() });
    });
    res.json({ ok: true });
  });

  // 프런트엔드 빌드 결과(frontend/dist)가 있으면 함께 제공
  const dist = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res, next) => res.sendFile(path.join(dist, 'index.html'), (err) => err && next()));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const env = process.env;
  const dataFile = env.DATA_FILE || './data/db.json';
  // 외부 DB(Upstash) 주소 · 토큰이 있으면 거기에, 없으면 임시 파일에 저장. 다 읽을 때까지(최대 8초) 기다린 뒤 시작
  const store = createStoreFromEnv(env);
  await store.ready;
  const provider = createLiveService({
    env, cache: await createCacheFromEnv(env), baseline: createBaseline({ file: path.join(path.dirname(dataFile), 'baseline.json') }),
  });
  const pusher = createPusher(env);
  // 테스트 전용: FAKE_NOW(ISO 시각)부터 시계가 흐르게 함
  const t0 = Date.now(), base = env.FAKE_NOW ? new Date(env.FAKE_NOW).getTime() : null;
  const now = base ? () => new Date(base + (Date.now() - t0)) : () => new Date();
  // v2.0 환승 경로: ODsay 검색 결과 · 하루 호출 수는 외부 DB(Upstash)에(없으면 메모리)
  const kv = createKvFromEnv(env, { clock: () => now().getTime() });
  const odsay = createOdsayService({ env, kv, clock: () => now().getTime() });
  const subway = createSubwayService({ env, kv, clock: () => now().getTime() });
  // v2.1 경로를 못 찾을 때 근처 국민대행 정류장 · 밤에 주요 환승역 경로 미리 찾기(스케줄러가 1분마다 한 곳씩)
  const nearKu = createNearKuFinder({ provider, clock: () => now().getTime() });
  const warmer = createOdsayWarmer({ env, odsay, provider, clock: () => now().getTime() });
  // v2.2.3 예전에 정밀하게 저장된 GPS 출발지(사용자 기록 · ODsay 검색 결과)를 약 100m 칸으로 — 저장소를 다 읽은 뒤 한 번
  const coords = createCoordMigration({ store, odsay, clock: () => now().getTime() });
  coords.start();
  // v2.2.4 마지막 사용 후 90일(RETENTION_DAYS) 지난 사용자 기록 자동 삭제 — 처음 켜질 때 기존 사용자는 지금을 기산점으로(바로 지워지지 않음)
  const retention = createRetention({ store, env, clock: () => now().getTime() });
  retention.start();
  const scheduler = createScheduler({ store, provider, pusher, now, pushWhenMock: env.PUSH_WHEN_MOCK === 'skip' ? 'skip' : 'label', subway, warmer });
  const courses = loadCourses(env.COURSES_FILE || undefined);
  const incidents = createAccidentService({ env, clock: () => now().getTime() });
  const weather = createWeatherService({ env, clock: () => now().getTime() });
  const explainer = createExplainService({ env, clock: () => now().getTime() });
  const app = createApp({ store, provider, pusher, now, scheduler, courses, incidents, weather, explainer, odsay, subway, nearKu, warmer, coords, retention });
  const port = Number(env.PORT) || 8787;
  const h = provider.health(), ih = incidents.health(), wh = weather.health(), eh = explainer.health(), si = store.info();
  app.listen(port, () => console.log(`KU BUS AI 서버 http://localhost:${port} (실시간: ${h.keyConfigured ? '서울시 API' : '키 없음 → 예시 데이터'}, 캐시: ${h.cache} ${h.cacheSec}초, 돌발정보: ${ih.keyConfigured ? `서울시 ${ih.cacheSec / 60}분마다` : '키 없음 → 꺼짐'}, 날씨: ${wh.keyConfigured ? `기상청 격자 ${wh.grid.nx},${wh.grid.ny} · ${wh.cacheSec / 60}분마다` : '키 없음 → 꺼짐'}, AI 설명: ${eh.keyConfigured ? `Gemini ${eh.model}` : '키 없음 → 기본 안내'}, 저장소: ${si.kind === 'upstash' ? `Upstash(${si.loaded ? `사용자 ${si.users}명` : '읽기 실패 → 다시 시도 중'})` : '임시 파일(재시작하면 지워짐)'}, 환승 경로: ${odsay.keyConfigured ? `ODsay(하루 ${odsay.health().cap}건 · 미리 찾기 ${warmer.health().list}곳 ${warmer.health().hours})` : 'ODSAY_API_KEY 없음 → 근처 국민대행 정류장 안내'}, 실시간 지하철: ${subway.keyConfigured ? '서울시' : '키 없음 → 표준 대기'}, 푸시: ${pusher.enabled ? '켜짐' : pusher.configError ? 'VAPID 설정 오류' : '꺼짐'}, 강의 목록: ${courses.meta.available ? `${courses.meta.count}개` : '없음'})`));
  scheduler.start();
  // Render가 서버를 멈출 때(잠들기 · 재배포) 아직 저장 안 된 기록을 마저 저장
  const bye = () => { scheduler.stop(); coords.stop(); retention.stop(); store.flush().catch(() => {}).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.once('SIGTERM', bye);
  process.once('SIGINT', bye);
}
