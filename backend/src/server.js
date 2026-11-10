// KU BUS AI 백엔드(Express). 실행: npm start  (.env는 .env.example 참고)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanRoute, createStore } from './store.js';
import { createBaseline, createLiveService } from './transit/index.js';
import { createCacheFromEnv } from './transit/cache.js';
import { reasonText } from '../../shared/liveStatus.js';
import { createPusher } from './push.js';
import { createScheduler } from './scheduler.js';
import { planFor } from './planner.js';
import { parseTimetableText } from '../../shared/parseTimetableText.js';
import { BUILDINGS, GATES, WALK_TABLE, DEFAULT_WALK_MIN } from '../../shared/campusData.js';
import { toHHMM, toMin } from '../../shared/time.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
function validClass(c, i) {
  const day = Number(c.day), start = clean(c.start, 5), end = clean(c.end, 5);
  if (!clean(c.name, 40)) throw new Error(`${i + 1}번째 수업: 과목명이 없어요`);
  if (!(day >= 0 && day <= 4)) throw new Error(`${i + 1}번째 수업: 요일은 0(월)~4(금)`);
  if (!(toMin(end) > toMin(start))) throw new Error(`${i + 1}번째 수업: 시각을 확인하세요`);
  return { id: clean(c.id, 40) || `c${Date.now().toString(36)}${i}`, name: clean(c.name, 40), day, start, end, building: clean(c.building, 30), room: clean(c.room, 12), color: Number(c.color) || 0 };
}

/** 테스트에서 시계·공급자를 바꿔 끼울 수 있게 앱을 함수로 만듭니다. provider = createLiveService() 또는 createMockProvider() */
export function createApp({ store, provider, pusher, now = () => new Date(), scheduler = null }) {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  // 데모용 사용자 식별: X-User-Id 헤더(실서비스는 학교 계정 로그인 등으로 교체)
  app.use((req, _res, next) => { req.userId = clean(req.get('x-user-id') || 'demo', 64); next(); });

  // 실시간 공급자 상태(seoul | mock + 폴백 이유)와 서버 푸시·스케줄러 상태
  app.get('/api/health', (_req, res) => {
    const live = provider.health ? provider.health() : { provider: provider.name, reason: provider.name === 'mock' ? 'demo' : null };
    const subscriptions = store.users().reduce((n, [, u]) => n + (u.push?.length || 0), 0);
    res.json({
      ok: true, provider: live.provider, reason: live.reason ?? null, reasonText: live.reasonText ?? reasonText(live.reason), live,
      push: { enabled: pusher.enabled, vapidConfigured: Boolean(pusher.publicKey), subscriptions },
      scheduler: scheduler?.status?.() ?? null,
    });
  });
  app.get('/api/meta', (_req, res) => res.json({ buildings: BUILDINGS, walkTable: WALK_TABLE, defaultWalkMin: DEFAULT_WALK_MIN, gates: GATES }));
  app.get('/api/me', (req, res) => { const { push, fired, ...u } = store.user(req.userId); res.json({ ...u, pushSubscriptions: push.length }); });

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
  // 오늘 첫 수업 기준 계획 + 지금 보낼 알림(미리 보기)
  app.get('/api/plan', async (req, res) => {
    try {
      const { now: n, plan, live, alarms } = await planFor(store.user(req.userId), provider, now());
      res.json({ now: { ...n, hhmm: toHHMM(n.minutes) }, source: live.source, provider: live.provider ?? live.source, reason: live.reason ?? null, plan, alarmsDue: alarms });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Web Push 구독
  app.get('/api/push/key', (_req, res) => res.json({ publicKey: pusher.publicKey, enabled: pusher.enabled }));
  app.post('/api/push/subscribe', (req, res) => {
    const s = req.body?.subscription;
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return res.status(400).json({ error: '구독 정보가 올바르지 않아요' });
    store.update(req.userId, (u) => { u.push = [...u.push.filter((x) => x.endpoint !== s.endpoint), s].slice(-5); });
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
  const store = createStore(dataFile);
  const provider = createLiveService({
    env, cache: await createCacheFromEnv(env), baseline: createBaseline({ file: path.join(path.dirname(dataFile), 'baseline.json') }),
  });
  const pusher = createPusher(env);
  // 테스트 전용: FAKE_NOW(ISO 시각)부터 시계가 흐르게 함
  const t0 = Date.now(), base = env.FAKE_NOW ? new Date(env.FAKE_NOW).getTime() : null;
  const now = base ? () => new Date(base + (Date.now() - t0)) : () => new Date();
  const scheduler = createScheduler({ store, provider, pusher, now, pushWhenMock: env.PUSH_WHEN_MOCK === 'skip' ? 'skip' : 'label' });
  const app = createApp({ store, provider, pusher, now, scheduler });
  const port = Number(env.PORT) || 8787;
  const h = provider.health();
  app.listen(port, () => console.log(`KU BUS AI 서버 http://localhost:${port} (실시간: ${h.keyConfigured ? '서울시 API' : '키 없음 → 예시 데이터'}, 캐시: ${h.cache} ${h.cacheSec}초, 푸시: ${pusher.enabled ? '켜짐' : '꺼짐'})`));
  scheduler.start();
}
