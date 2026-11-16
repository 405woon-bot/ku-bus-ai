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
import { planFor } from './planner.js';
import { parseTimetableText } from '../../shared/parseTimetableText.js';
import { BUILDINGS, GATES, WALK_TABLE, DEFAULT_WALK_MIN } from '../../shared/campusData.js';
import { seoulParts, toHHMM, toMin } from '../../shared/time.js';
import { searchCourses } from '../../shared/courses.js';
import { loadCourses } from './courses.js';
import { createAccidentService } from './transit/seoulAccident.js';
import { createWeatherService } from './transit/kmaWeather.js';
import { createExplainService } from './transit/geminiExplain.js';
import { delayMinutes } from '../../shared/explain.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const ARS_ID = /^\d{5}$/; // 서울시 정류소 번호(arsId)
const HANDOFF_MS = 2 * 3600_000; // 홈 화면 앱 이어받기 코드 유효 시간(한 번만 쓰임)
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
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
 */
export function createApp({ store, provider, pusher, now = () => new Date(), scheduler = null, courses = loadCourses(), incidents = null, weather = null, explainer = null }) {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  // 데모용 사용자 식별: X-User-Id 헤더(실서비스는 학교 계정 로그인 등으로 교체)
  app.use((req, _res, next) => { req.userId = clean(req.get('x-user-id') || 'demo', 64); next(); });
  // 외부 DB(Upstash)에서 사용자 기록을 다 읽기 전에는 /api 요청을 잠깐 기다리게 함(빈 기록으로 덮어쓰지 않게)
  app.use('/api', (_req, _res, next) => { Promise.resolve(store.ready).then(() => next(), () => next()); });
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
    });
  });
  app.get('/api/meta', (_req, res) => res.json({ buildings: BUILDINGS, walkTable: WALK_TABLE, defaultWalkMin: DEFAULT_WALK_MIN, gates: GATES }));
  app.get('/api/me', (req, res) => { const { push, fired, pushLog, handoff, ...u } = store.user(req.userId); res.json({ ...u, pushSubscriptions: push.length }); });
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
      const { now: n, rec, live, alarms, mockData } = await planFor(store.user(req.userId), provider, now());
      res.json({ now: { ...n, hhmm: toHHMM(n.minutes) }, source: live?.source ?? null, reason: live?.reason ?? null, reasonText: live?.reasonText ?? '', stale: Boolean(live?.stale), mockData, rec, trips: live?.trips ?? [], alarmsDue: alarms });
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
  const scheduler = createScheduler({ store, provider, pusher, now, pushWhenMock: env.PUSH_WHEN_MOCK === 'skip' ? 'skip' : 'label' });
  const courses = loadCourses(env.COURSES_FILE || undefined);
  const incidents = createAccidentService({ env, clock: () => now().getTime() });
  const weather = createWeatherService({ env, clock: () => now().getTime() });
  const explainer = createExplainService({ env, clock: () => now().getTime() });
  const app = createApp({ store, provider, pusher, now, scheduler, courses, incidents, weather, explainer });
  const port = Number(env.PORT) || 8787;
  const h = provider.health(), ih = incidents.health(), wh = weather.health(), eh = explainer.health(), si = store.info();
  app.listen(port, () => console.log(`KU BUS AI 서버 http://localhost:${port} (실시간: ${h.keyConfigured ? '서울시 API' : '키 없음 → 예시 데이터'}, 캐시: ${h.cache} ${h.cacheSec}초, 돌발정보: ${ih.keyConfigured ? `서울시 ${ih.cacheSec / 60}분마다` : '키 없음 → 꺼짐'}, 날씨: ${wh.keyConfigured ? `기상청 격자 ${wh.grid.nx},${wh.grid.ny} · ${wh.cacheSec / 60}분마다` : '키 없음 → 꺼짐'}, AI 설명: ${eh.keyConfigured ? `Gemini ${eh.model}` : '키 없음 → 기본 안내'}, 저장소: ${si.kind === 'upstash' ? `Upstash(${si.loaded ? `사용자 ${si.users}명` : '읽기 실패 → 다시 시도 중'})` : '임시 파일(재시작하면 지워짐)'}, 푸시: ${pusher.enabled ? '켜짐' : pusher.configError ? 'VAPID 설정 오류' : '꺼짐'}, 강의 목록: ${courses.meta.available ? `${courses.meta.count}개` : '없음'})`));
  scheduler.start();
  // Render가 서버를 멈출 때(잠들기 · 재배포) 아직 저장 안 된 기록을 마저 저장
  const bye = () => { scheduler.stop(); store.flush().catch(() => {}).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.once('SIGTERM', bye);
  process.once('SIGINT', bye);
}
