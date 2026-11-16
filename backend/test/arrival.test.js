// '도착했어요!' API: 오늘 첫 수업 · 버튼 시간(시작 30분 전 ~ 15분 뒤) · 한 수업에 한 번 · 내 걸음 반영(EMA) 학습 ·
// 누른 시각(휴대폰 시계) 처리 · 되돌리기 · 처음부터 · 외부 DB(Upstash)에 저장 · 추천 · 서버 알림 계산에 반영
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalTime, createApp } from '../src/server.js';
import { createStore, tidyUser } from '../src/store.js';
import { createUpstash, upstashUsers } from '../src/upstash.js';
import { createMockProvider } from '../src/transit/index.js';
import { planFor } from '../src/planner.js';
import { UPSTASH_URL, fakeUpstashFetch } from './fixtures/upstashFixture.js';

const kst = (s) => new Date(`${s}+09:00`); // 서울 시각
const fakePusher = { enabled: false, publicKey: null, send: async () => [] };
const quiet = { warn() {}, info() {}, error() {} };
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };

async function serve(fn, { store = createStore(null) } = {}) {
  const clock = { t: kst('2026-11-16T08:10:00') }; // 월요일
  const provider = createMockProvider('jeongneung');
  const app = createApp({ store, provider, pusher: fakePusher, now: () => clock.t });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, uid = 'u1') => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': uid }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(req, clock); } finally { srv.close(); provider.stop?.(); }
}
const setup = async (req) => {
  assert.equal((await req('PUT', '/api/me/timetable', { classes: [CLASS] })).status, 200);
  assert.equal((await req('PATCH', '/api/me', { stop: { arsId: '08901', name: '정릉시장' } })).status, 200);
};

test('도착 기록: 수업 없는 날 · 버튼 시간 전은 422 → 시간 안이면 학습(+1.5, 반영 +2분) → 같은 수업 두 번째는 409(기록 그대로)', async () => {
  await serve(async (req, clock) => {
    await setup(req);
    clock.t = kst('2026-11-15T08:58:00'); // 일요일
    let r = await req('POST', '/api/me/arrival', {});
    assert.deepEqual([r.status, r.body.kind], [422, 'no-class']);
    clock.t = kst('2026-11-16T08:10:00');
    r = await req('POST', '/api/me/arrival', { classId: 'c1' });
    assert.deepEqual([r.status, r.body.kind], [422, 'outside-window']);
    assert.match(r.body.error, /08:30 ~ 09:15/);
    clock.t = kst('2026-11-16T08:58:00');
    r = await req('POST', '/api/me/arrival', { classId: 'c1' });
    assert.equal(r.status, 200);
    const rec = r.body.record;
    assert.deepEqual([rec.key, rec.classId, rec.arriveMin, rec.slackMin, rec.verdict, rec.prevOffsetMin, rec.offsetMin, rec.at],
      ['2026-11-16:c1', 'c1', 538, 2, 'tight', 0, 1.5, '2026-11-15T23:58:00.000Z']);
    assert.deepEqual([r.body.personal.offsetMin, r.body.personal.samples, r.body.arrivals.length], [1.5, 1, 1]);
    clock.t = kst('2026-11-16T09:01:00');
    const again = await req('POST', '/api/me/arrival', { classId: 'c1' });
    assert.deepEqual([again.status, again.body.kind, again.body.record.arriveMin, again.body.personal.offsetMin], [409, 'already', 538, 1.5], '한 수업에 한 번만');
    // 내 정보 · 추천에 반영(정수로 반올림 +2분)
    const me = (await req('GET', '/api/me')).body;
    assert.deepEqual([me.personal.offsetMin, me.arrivals.length, 'push' in me, 'fired' in me], [1.5, 1, false, false]);
    clock.t = kst('2026-11-16T08:40:00');
    const plan = (await req('GET', '/api/plan')).body;
    assert.equal(plan.rec.personalMin, 2);
    // 다른 사용자에게는 영향 없음
    assert.equal((await req('GET', '/api/me', null, 'u2')).body.personal.offsetMin, 0);
  });
});

test('시간표가 바뀌어 첫 수업이 다르면 422 · 시작 15분 뒤까지는 기록(늦음 → 한 번에 최대 +3)', async () => {
  await serve(async (req, clock) => {
    await setup(req);
    clock.t = kst('2026-11-16T09:05:00');
    assert.equal((await req('POST', '/api/me/arrival', { classId: 'old-id' })).body.kind, 'class-changed');
    const r = await req('POST', '/api/me/arrival', { classId: 'c1' });
    assert.deepEqual([r.status, r.body.record.verdict, r.body.record.offsetMin, r.body.record.slackMin], [200, 'late', 3, -5]);
    clock.t = kst('2026-11-17T09:16:00'); // 화요일(수업 없음)
    assert.equal((await req('POST', '/api/me/arrival', {})).body.kind, 'no-class');
  });
});

test('누른 시각: 휴대폰 시계가 서버와 2분 안이면 그대로(서버가 늦게 받아도) · 틀리면 지난 시간만 · 이상하면 서버 시각', async () => {
  const T = kst('2026-11-16T08:58:00').getTime();
  assert.equal(arrivalTime({ pressedAt: T - 40_000, sentAt: T - 40_000 }, T), T - 40_000, '서버가 잠에서 깨느라 40초 늦게 받음');
  assert.equal(arrivalTime({ pressedAt: T - 10 * 60_000, sentAt: T }, T), T - 10 * 60_000, '연결이 끊겨 10분 뒤에 다시 보냄');
  assert.equal(arrivalTime({ pressedAt: T + 3600_000 - 30_000, sentAt: T + 3600_000 }, T), T - 30_000, '휴대폰 시계가 1시간 빠름');
  assert.equal(arrivalTime({ pressedAt: 'x' }, T), T);
  assert.equal(arrivalTime({ pressedAt: T - 9e6, sentAt: T - 9e6 - 1 }, T), T, '보낸 시각이 누른 시각보다 앞이면 서버 시각');
  assert.equal(arrivalTime({ pressedAt: T - 8 * 3600_000, sentAt: T }, T), T, '6시간 넘게 지난 기록은 서버 시각');
  assert.equal(arrivalTime(null, T), T);
  await serve(async (req, clock) => {
    await setup(req);
    clock.t = kst('2026-11-16T09:30:00'); // 버튼 시간이 지났지만, 08:57에 누른 기록을 이제야 보냄(휴대폰 시계 정확)
    const pressedAt = kst('2026-11-16T08:57:00').getTime();
    const r = await req('POST', '/api/me/arrival', { classId: 'c1', pressedAt, sentAt: clock.t.getTime() });
    assert.deepEqual([r.status, r.body.record.arriveMin, r.body.record.slackMin], [200, 537, 3]);
  });
});

test('되돌리기: 오늘 · 마지막 기록만(보정이 이전 값으로, 버튼 다시) · 처음부터: 보정 0 · 기록 지움', async () => {
  await serve(async (req, clock) => {
    await setup(req);
    clock.t = kst('2026-11-16T08:40:00');
    const first = (await req('POST', '/api/me/arrival', {})).body;
    assert.deepEqual([first.record.verdict, first.personal.offsetMin], ['early', -2], '20분 일찍 → 한 번에 최대 −2');
    assert.equal((await req('POST', '/api/me/arrival/undo', { key: '2026-11-13:c1' })).body.kind, 'not-today');
    assert.equal((await req('POST', '/api/me/arrival/undo', { key: '2026-11-16:zz' })).status, 404);
    const u = await req('POST', '/api/me/arrival/undo', { key: first.record.key });
    assert.deepEqual([u.status, u.body.personal.offsetMin, u.body.personal.samples, u.body.arrivals.length, u.body.removed.key], [200, 0, 0, 0, '2026-11-16:c1']);
    clock.t = kst('2026-11-16T08:58:00');
    const second = await req('POST', '/api/me/arrival', {});
    assert.deepEqual([second.status, second.body.personal.offsetMin], [200, 1.5], '되돌린 뒤에는 다시 기록');
    const reset = (await req('POST', '/api/me/personal/reset', {})).body;
    assert.deepEqual([reset.personal, reset.arrivals], [{ offsetMin: 0, samples: 0, updatedAt: null }, []]);
  });
});

test('외부 DB(Upstash): 내 걸음 반영 · 도착 기록이 서버를 다시 시작해도 그대로 · 기록은 최근 20개', async () => {
  const data = {};
  const mk = () => createStore(null, { remote: upstashUsers(createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) })), log: quiet, flushMs: 10 });
  const s1 = mk(); await s1.ready;
  await serve(async (req, clock) => {
    await setup(req);
    clock.t = kst('2026-11-16T09:02:00');
    assert.equal((await req('POST', '/api/me/arrival', {})).status, 200);
  }, { store: s1 });
  await s1.flush(); s1.stop();
  const saved = JSON.parse(data['kubusai:users'].u1);
  assert.deepEqual([saved.personal.offsetMin, saved.arrivals.length], [3, 1]);
  const s2 = mk(); await s2.ready;
  assert.deepEqual([s2.user('u1').personal.offsetMin, s2.user('u1').arrivals[0].key], [3, '2026-11-16:c1'], '다시 시작해도 그대로');
  s2.stop();
  const u = tidyUser({ arrivals: Array.from({ length: 26 }, (_, i) => ({ key: `k${i}` })) });
  assert.deepEqual([u.arrivals.length, u.arrivals[0].key], [20, 'k6']);
  assert.deepEqual(createStore(null).user('new').personal, { offsetMin: 0, samples: 0, updatedAt: null }, '예전 사용자 · 새 사용자는 보정 0');
});

test('서버 출발 알림도 같은 보정: +3분이면 더 일찍 도착하는 차 · 출발 알림도 앞당김', async () => {
  const user = { classes: [CLASS], stop: { arsId: '08901', name: '정릉시장' }, prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {} };
  const provider = createMockProvider('jeongneung');
  const at = kst('2026-11-16T08:05:00');
  const a = await planFor(user, provider, at);
  const b = await planFor({ ...user, personal: { offsetMin: 3.4, samples: 2 } }, provider, at);
  provider.stop?.();
  assert.equal(a.rec.state, 'ok');
  assert.deepEqual([a.rec.personalMin, b.rec.personalMin], [0, 3]);
  assert.ok(b.rec.pick.classArriveMin <= 9 * 60 - 5 || b.rec.status !== 'relaxed', '보정을 더해도 목표 안이거나 상태로 알림');
  assert.ok(b.rec.pick.departMin <= a.rec.pick.departMin, `출발 ${b.rec.pick.departMin} <= ${a.rec.pick.departMin}`);
});

test("'도착했어요!'를 누른 날은 그 수업의 출발 · 지각 위험 알림을 더 보내지 않음(다른 날은 그대로)", async () => {
  const user = { classes: [CLASS], stop: { arsId: '08901', name: '정릉시장' }, prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {} };
  const provider = createMockProvider('jeongneung');
  const at = kst('2026-11-16T08:52:00'); // 이 시각이면 출발(지금 출발) · 지각 위험 알림이 걸림
  const before = await planFor(user, provider, at);
  const after = await planFor({ ...user, arrivals: [{ key: '2026-11-16:c1' }] }, provider, at);
  const otherDay = await planFor({ ...user, arrivals: [{ key: '2026-11-09:c1' }] }, provider, at);
  provider.stop?.();
  assert.ok(before.alarms.length > 0 && !before.arrived, JSON.stringify(before.alarms.map((x) => x.type)));
  assert.deepEqual([after.alarms, after.arrived], [[], true]);
  assert.ok(otherDay.alarms.length > 0 && !otherDay.arrived);
});
