import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createMockProvider } from '../src/transit/index.js';

// 서울 시각 2026-11-09(월) 08:10 = UTC 2026-11-08 23:10
const MON_0810 = new Date('2026-11-08T23:10:00Z');
const fakePusher = { enabled: false, publicKey: null, send: async () => [] };

async function withServer(fn, now = () => MON_0810) {
  const app = createApp({ store: createStore(null), provider: createMockProvider('jeongneung'), pusher: fakePusher, now });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}

test('GET /api/plan: 월요일 08:10 정릉로 정체 예시 → 통합 알림 문구와 지연 알림', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/plan`)).json();
    assert.equal(j.now.hhmm, '08:10');
    assert.equal(j.source, 'mock');
    assert.equal(j.plan.message, '현재 정릉로 정체로 171번 8분 지연! 8:31까지 출발을 권장합니다. (대체 추천: 후문 방향 1112번 탑승 시 정시 출발 가능)');
    assert.deepEqual(j.alarmsDue.map((a) => a.type), ['delay']);
  });
});

test('시간표 저장 검증과 텍스트 가져오기', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/me/timetable`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classes: [{ name: '', day: 0, start: '09:00', end: '10:00' }] }) });
    assert.equal(bad.status, 400);
    const r = await (await fetch(`${base}/api/me/timetable/import-text`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '알고리즘 화목 09:00-10:15 공학관 101\n그냥 메모', apply: true, replace: true }) })).json();
    assert.equal(r.count, 2);
    const me = await (await fetch(`${base}/api/me`)).json();
    assert.deepEqual(me.classes.map((c) => [c.name, c.day, c.start]), [['알고리즘', 1, '09:00'], ['알고리즘', 3, '09:00']]);
  });
});

test('GET /api/live: 노선별 실시간(예시)', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/live?routes=171,1112`)).json();
    assert.deepEqual(j.routes.map((r) => [r.no, r.liveMin]), [['171', 20], ['1112', 13]]);
    assert.equal(j.cause, '정릉로');
  });
});

/* ── v0.3: 서울시 실시간 연동(가짜 서울시 서버) ── */
import { createLiveService } from '../src/transit/index.js';
import { buildPlan, causeFor } from '../../shared/departure.js';
import { WALK_TABLE } from '../../shared/campusData.js';
import { toMin } from '../../shared/time.js';
import { USER_ROUTES, fakeSeoulFetch } from './fixtures/seoulFixture.js';

const quietLog = { warn() {}, info() {}, error() {} };
async function withLive(fn, { key = 'TESTKEY', fetchImpl = fakeSeoulFetch() } = {}) {
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: key }, fetchImpl, background: false, log: quietLog });
  const app = createApp({ store: createStore(null), provider, pusher: fakePusher, now: () => MON_0810 });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try { await fn(req, fetchImpl); } finally { srv.close(); provider.stop(); }
}

test('승차 정류장 설정 전에는 예시 데이터(이유: 승차 정류장 미설정), 설정 후 /api/live는 서울시 실시간', async () => {
  await withLive(async (req) => {
    let live = (await req('GET', '/api/live?routes=171,1711,1112')).body;
    assert.deepEqual([live.provider, live.reasonText], ['mock', '승차 정류장 미설정']);
    assert.equal((await req('PATCH', '/api/me/settings', { routes: [{ ...USER_ROUTES[0], boardArsId: '1234' }] })).status, 400);
    assert.equal((await req('PATCH', '/api/me/settings', { routes: USER_ROUTES })).status, 200);
    live = (await req('GET', '/api/live?routes=171,1711,1112')).body;
    assert.equal(live.provider, 'seoul');
    assert.deepEqual(live.routes.map((r) => [r.id, r.liveMin, r.usualMin, r.delayMin, r.status.level, r.cause]), [
      ['171', 18, 12, 6, 'danger', '정릉로'], ['1711', 12, 14, 0, 'ok', '정릉3동주민센터앞→청덕초등학교입구 구간'], ['1112', 7, 13, 0, 'ok', null]]);
    const h = (await req('GET', '/api/health')).body;
    assert.deepEqual([h.provider, h.reason, h.live.keyConfigured, h.push.enabled], ['seoul', null, true, false]);
    assert.ok(!JSON.stringify(h).includes('TESTKEY'));
  });
});

test('계산식 일치: /api/plan(백엔드) = 화면과 같은 buildPlan(프런트엔드 경로) = 수업 − 도보 − 여유 5분 − 실시간 소요', async () => {
  await withLive(async (req) => {
    await req('PATCH', '/api/me/settings', { routes: USER_ROUTES });
    const plan = (await req('GET', '/api/plan')).body;
    assert.equal(plan.provider, 'seoul');
    const p = plan.plan;
    assert.equal(p.recommendedDepartMin, toMin('09:00') - 4 - 5 - 18);   // 08:33
    assert.equal(p.message, '현재 정릉로 정체로 171번 6분 지연! 8:33까지 출발을 권장합니다. (대체 추천: 후문 방향 1112번 탑승 시 정시 출발 가능)');
    for (const r of p.plans) assert.equal(r.departLiveMin, toMin('09:00') - r.walkMin - 5 - r.liveMin);
    // 프런트엔드: /api/live 응답 → shared/departure.js(buildPlan·causeFor) — App.jsx와 같은 호출
    const live = (await req('GET', '/api/live?routes=171,1711,1112')).body;
    const me = (await req('GET', '/api/me')).body;
    const cls = me.classes.find((c) => c.day === 0);
    const front = buildPlan({ cls, routes: live.routes, primaryId: me.primaryRouteId, walkTable: WALK_TABLE, marginMin: me.settings.marginMin, notifyBeforeMin: me.settings.notifyBeforeMin, cause: causeFor(live, me.primaryRouteId) });
    assert.equal(front.recommendedDepartMin, p.recommendedDepartMin);
    assert.equal(front.alarmAtMin, p.alarmAtMin);
    assert.equal(front.message, p.message);
    assert.deepEqual(front.plans.map((x) => [x.id, x.departLiveMin]), p.plans.map((x) => [x.id, x.departLiveMin]));
  });
});

test('노선 정류장 목록(승차 정류장 고르기)과 키 없는 서버의 안내', async () => {
  await withLive(async (req) => {
    const r = await req('GET', '/api/routes/171/stations');
    assert.equal(r.status, 200);
    assert.equal(r.body.busRouteId, '900000171');
    assert.deepEqual(r.body.stations.slice(1, 3).map((s) => [s.seq, s.arsId, s.name]), [[2, '08901', '정릉시장'], [3, '08902', '정릉3동주민센터앞']]);
    assert.equal((await req('GET', '/api/routes/9999/stations')).status, 404);
  });
  await withLive(async (req, f) => {
    const st = await req('GET', '/api/routes/171/stations');
    assert.equal(st.status, 503);
    assert.equal(st.body.kind, 'no-key');
    const h = (await req('GET', '/api/health')).body;
    assert.deepEqual([h.provider, h.reason, h.reasonText], ['mock', 'no-key', 'API 키 없음']);
    assert.equal((await req('GET', '/api/live')).body.provider, 'mock');
    assert.equal(f.calls.length, 0);
  }, { key: '' });
});
