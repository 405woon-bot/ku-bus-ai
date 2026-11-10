import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService, createMockProvider } from '../src/transit/index.js';
import { recommend } from '../../shared/recommend.js';
import { WALK_TABLE } from '../../shared/campusData.js';
import { USER_ROUTES, fakeSeoulFetch } from './fixtures/seoulFixture.js';

// 서울 시각 2026-11-09(월) 08:10 = UTC 2026-11-08 23:10
const MON_0810 = new Date('2026-11-08T23:10:00Z');
const fakePusher = { enabled: false, publicKey: null, send: async () => [] };
const quietLog = { warn() {}, info() {}, error() {} };
const CLASS = { name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };

async function serve(provider, fn) {
  const app = createApp({ store: createStore(null), provider, pusher: fakePusher, now: () => MON_0810 });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try { await fn(req); } finally { srv.close(); provider.stop?.(); }
}
const seoul = (key = 'TESTKEY', fetchImpl = fakeSeoulFetch()) => createLiveService({ env: { SEOUL_BUS_API_KEY: key }, fetchImpl, background: false, log: quietLog });

test('새 사용자: 시간표 비어 있음, 탑승 정류장 없음 → /api/plan은 no-stop', async () => {
  await serve(createMockProvider('jeongneung'), async (req) => {
    const me = (await req('GET', '/api/me')).body;
    assert.deepEqual([me.classes, me.stop, me.prefs], [[], null, { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }]);
    assert.equal((await req('GET', '/api/plan')).body.rec.state, 'no-stop');
  });
});

test('시간표 저장 검증과 텍스트 가져오기', async () => {
  await serve(createMockProvider('jeongneung'), async (req) => {
    assert.equal((await req('PUT', '/api/me/timetable', { classes: [{ name: '', day: 0, start: '09:00', end: '10:00' }] })).status, 400);
    const r = (await req('POST', '/api/me/timetable/import-text', { text: '알고리즘 화목 09:00-10:15 공학관 101\n그냥 메모', apply: true, replace: true })).body;
    assert.equal(r.count, 2);
    const me = (await req('GET', '/api/me')).body;
    assert.deepEqual(me.classes.map((c) => [c.name, c.day, c.start]), [['알고리즘', 1, '09:00'], ['알고리즘', 3, '09:00']]);
  });
});

test('탑승 정류장 저장(PATCH /api/me): 번호는 5자리, 설정값 범위 제한', async () => {
  await serve(createMockProvider('jeongneung'), async (req) => {
    assert.equal((await req('PATCH', '/api/me', { stop: { arsId: '1234', name: 'x' } })).status, 400);
    assert.equal((await req('PATCH', '/api/me', { stop: { arsId: '08901', name: '정릉시장' }, prefs: { walkToStopMin: 99, notify: false } })).status, 200);
    const me = (await req('GET', '/api/me')).body;
    assert.deepEqual([me.stop, me.prefs.walkToStopMin, me.prefs.notify], [{ arsId: '08901', name: '정릉시장' }, 30, false]);
  });
});

test('정류장 검색·내 주변·정류장별 국민대행 노선 API (서울시 응답 기준)', async () => {
  await serve(seoul(), async (req) => {
    assert.equal((await req('GET', '/api/stops?q=정')).status, 400);
    assert.deepEqual((await req('GET', '/api/stops?q=정릉')).body.stops.map((s) => s.arsId), ['08901', '08911', '08902']);
    assert.deepEqual((await req('GET', '/api/stops/near?lat=37.6061&lon=127.0102')).body.stops.map((s) => s.arsId), ['08911', '08901', '08902']);
    assert.equal((await req('GET', '/api/stops/near?lat=abc')).status, 400);
    assert.equal((await req('GET', '/api/stops/abc/trips')).status, 400);
    const j = (await req('GET', '/api/stops/08901/trips')).body;
    assert.deepEqual([j.source, j.stale], ['seoul', false]);
    assert.deepEqual(j.trips.map((t) => [t.no, t.gate, t.cause]), [['1711', '정문', '정릉3동주민센터앞→청덕초등학교입구 구간'], ['171', '정문', '정릉로'], ['1112', '후문', null]]);
    const h = (await req('GET', '/api/health')).body;
    assert.deepEqual([h.provider, h.reason, h.live.keyConfigured], ['seoul', null, true]);
    assert.ok(!JSON.stringify(h).includes('TESTKEY'));
  });
});

test('계산 일치: /api/plan(서버) = 화면과 같은 recommend(/api/stops/:arsId/trips 응답) — 출발 = 탑승 − 정류장까지 걷기', async () => {
  await serve(seoul(), async (req) => {
    await req('PUT', '/api/me/timetable', { classes: [CLASS] });
    await req('PATCH', '/api/me', { stop: { arsId: '08901', name: '정릉시장' } });
    const plan = (await req('GET', '/api/plan')).body;
    assert.deepEqual([plan.now.hhmm, plan.source, plan.mockData], ['08:10', 'seoul', false]);
    const p = plan.rec.pick;
    // 171번 08:30 탑승(08:22 다음 차를 배차간격 8분으로 이음) + 차내 17.8분 + 정문→미래관 4분 = 08:52 도착(여유), 출발 08:25
    assert.deepEqual([p.trip.no, p.boardMin, p.departMin, plan.rec.status], ['171', 510, 505, 'relaxed']);
    assert.ok(Math.abs(p.classArriveMin - (510 + 17.81 + 4)) < 0.01);
    // 화면 경로: 같은 응답 → shared/recommend.js (App.jsx와 같은 호출)
    const live = (await req('GET', '/api/stops/08901/trips')).body;
    const me = (await req('GET', '/api/me')).body;
    const front = recommend({ trips: live.trips, cls: me.classes[0], nowMin: 8 * 60 + 10, walkTable: WALK_TABLE, walkToStopMin: me.prefs.walkToStopMin, marginMin: me.prefs.marginMin });
    assert.deepEqual([front.pick.trip.no, front.pick.boardMin, front.pick.departMin, front.pick.classArriveMin, front.status],
      [p.trip.no, p.boardMin, p.departMin, p.classArriveMin, plan.rec.status]);
  });
});

test('키 없는 서버: 정류장 검색은 이유와 함께 503, 이미 고른 정류장은 예시 데이터(이유: API 키 없음)', async () => {
  const f = fakeSeoulFetch();
  await serve(seoul('', f), async (req) => {
    const s = await req('GET', '/api/stops?q=정릉');
    assert.deepEqual([s.status, s.body.kind], [503, 'no-key']);
    const j = (await req('GET', '/api/stops/08901/trips')).body;
    assert.deepEqual([j.source, j.reason, j.reasonText], ['mock', 'no-key', 'API 키 없음']);
    await req('PUT', '/api/me/timetable', { classes: [CLASS] });
    await req('PATCH', '/api/me', { stop: { arsId: '08901', name: '정릉시장' } });
    const plan = (await req('GET', '/api/plan')).body;
    assert.deepEqual([plan.source, plan.reason, plan.mockData, plan.rec.state], ['mock', 'no-key', true, 'ok']);
    const h = (await req('GET', '/api/health')).body;
    assert.deepEqual([h.provider, h.reason, h.reasonText], ['mock', 'no-key', 'API 키 없음']);
    assert.equal(f.calls.length, 0);
  });
});

/* ── v0.3 노선별 API(/api/live, 노선 설정) — 호환 유지 ── */
test('GET /api/live: 노선별 실시간(예시)', async () => {
  await serve(createMockProvider('jeongneung'), async (req) => {
    const j = (await req('GET', '/api/live?routes=171,1112')).body;
    assert.deepEqual(j.routes.map((r) => [r.no, r.liveMin]), [['171', 20], ['1112', 13]]);
    assert.equal(j.cause, '정릉로');
  });
});

test('v0.3 노선 설정 전에는 예시 데이터(승차 정류장 미설정), 설정 후 /api/live는 서울시 실시간', async () => {
  await serve(seoul(), async (req) => {
    let live = (await req('GET', '/api/live?routes=171,1711,1112')).body;
    assert.deepEqual([live.provider, live.reasonText], ['mock', '승차 정류장 미설정']);
    assert.equal((await req('PATCH', '/api/me/settings', { routes: [{ ...USER_ROUTES[0], boardArsId: '1234' }] })).status, 400);
    assert.equal((await req('PATCH', '/api/me/settings', { routes: USER_ROUTES })).status, 200);
    live = (await req('GET', '/api/live?routes=171,1711,1112')).body;
    assert.equal(live.provider, 'seoul');
    assert.deepEqual(live.routes.map((r) => [r.id, r.liveMin, r.usualMin, r.delayMin, r.status.level, r.cause]), [
      ['171', 18, 12, 6, 'danger', '정릉로'], ['1711', 12, 14, 0, 'ok', '정릉3동주민센터앞→청덕초등학교입구 구간'], ['1112', 7, 13, 0, 'ok', null]]);
  });
});

test('노선 정류장 목록(GET /api/routes/:no/stations)과 키 없는 서버의 안내', async () => {
  await serve(seoul(), async (req) => {
    const r = await req('GET', '/api/routes/171/stations');
    assert.equal(r.status, 200);
    assert.equal(r.body.busRouteId, '900000171');
    assert.deepEqual(r.body.stations.slice(1, 3).map((s) => [s.seq, s.arsId, s.name]), [[2, '08901', '정릉시장'], [3, '08902', '정릉3동주민센터앞']]);
    assert.equal((await req('GET', '/api/routes/9999/stations')).status, 404);
  });
  await serve(seoul(''), async (req) => {
    const st = await req('GET', '/api/routes/171/stations');
    assert.deepEqual([st.status, st.body.kind], [503, 'no-key']);
  });
});
