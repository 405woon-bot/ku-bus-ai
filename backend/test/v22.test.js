// v2.2 서버 점검: '출발했어요!' 기록(수업 · 경로 · 시간 확인, 같은 누름 다시 보냄, 지우기) · 누르면 출발 알림을 그만 보냄 ·
// 환승 실시간 재료(지하철 실시간 시간대)도 누른 시각 기준. 메모리 저장소 · 가짜 공급자만 씁니다(실제 서버 호출 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { departedMinFor, planFor } from '../src/planner.js';
import { transitLive } from '../src/transit/transitLive.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { hhmm, parseOdsayResult, routeKey } from '../../shared/transitPlan.js';

const kst = (s) => new Date(`${s}+09:00`);
const ROUTE = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0]; // 2호선(홍대입구) → 4호선 → 1213(길음역)
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '13:00', end: '14:15', building: '미래관', room: '301' }; // 월요일
// 마지막 국민대행 버스: 서울시 실시간 자리(도착 정보 없음 → 배차로 예상) — 실제 서울시 API를 부르지 않음
const provider = { name: 'seoul', stopTrips: async (arsId, now) => ({ trips: [], source: 'seoul', stale: false, ageSec: 0, fetchedAt: now.toISOString(), arsId }), stopArrivals: async () => ({ arrivals: [] }), health: () => ({ provider: 'seoul' }) };

async function server(clock) {
  const store = createStore(null);
  const app = createApp({ store, provider, pusher: { enabled: false, publicKey: null }, now: () => clock.t });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, uid = 'u22') => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': uid }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { store, req, close: () => new Promise((r) => srv.close(r)) };
}
const withTransit = (store, uid, extra = {}) => store.update(uid, (u) => {
  u.classes = [CLASS];
  u.transit = { mode: 'transit', origin: { name: '홍대입구역', lat: 37.557527, lon: 126.923778, kind: 'stop' }, route: ROUTE, savedAt: '2026-11-20T00:00:00Z', retry: null };
  Object.assign(u, extra);
});

test("출발했어요! 기록: 수업 · 환승 경로 · 시간(수업 4시간 전 ~ 시작 전)을 서버 시각으로 확인 · 같은 누름은 처음 기록 그대로 · 지우기", async () => {
  const clock = { t: kst('2026-11-23T11:30:00') }; // 월요일
  const { store, req, close } = await server(clock);
  try {
    assert.equal(store.user('u22').departure, null, '새 사용자는 출발 기록 없음');
    // 수업 없음
    const none = await req('POST', '/api/me/departure', { pressedAt: clock.t.getTime(), sentAt: clock.t.getTime() });
    assert.deepEqual([none.status, none.body.kind], [422, 'no-class']);
    // 직행 모드(환승 경로 없음)
    store.update('u22', (u) => { u.classes = [CLASS]; });
    const direct = await req('POST', '/api/me/departure', { classId: 'c1' });
    assert.deepEqual([direct.status, direct.body.kind], [422, 'no-route']);
    withTransit(store, 'u22');
    // 다른 수업 id · 다른 경로 표
    assert.equal((await req('POST', '/api/me/departure', { classId: 'zz' })).body.kind, 'class-changed');
    const moved = await req('POST', '/api/me/departure', { classId: 'c1', routeKey: 'other#1' });
    assert.deepEqual([moved.status, moved.body.kind], [409, 'route-changed']);
    // 시간 밖: 08:30(수업 4시간 30분 전)
    clock.t = kst('2026-11-23T08:30:00');
    const early = await req('POST', '/api/me/departure', { classId: 'c1', pressedAt: clock.t.getTime(), sentAt: clock.t.getTime() });
    assert.deepEqual([early.status, early.body.kind], [422, 'outside-window']);
    assert.match(early.body.error, /^출발 기록은 09:00 ~ 13:00/);
    // 11:33에 누름 → 저장(누른 시각 그대로 · 경로 표)
    clock.t = kst('2026-11-23T11:33:20');
    const pressed = clock.t.getTime() - 20_000; // 20초 전에 누른 것을 지금 받음
    const ok = await req('POST', '/api/me/departure', { classId: 'c1', pressedAt: pressed, sentAt: clock.t.getTime(), routeKey: routeKey(ROUTE) });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.departure.key, ok.body.departure.routeKey, hhmm(ok.body.departure.departMin), ok.body.departure.at], ['2026-11-23:c1', routeKey(ROUTE), '11:33', new Date(pressed).toISOString()]);
    // 연결이 끊겨 같은 누름을 다시 보냄 → 처음 기록 그대로
    clock.t = kst('2026-11-23T11:36:00');
    const again = await req('POST', '/api/me/departure', { classId: 'c1', pressedAt: clock.t.getTime(), sentAt: clock.t.getTime() });
    assert.deepEqual([again.status, again.body.already, hhmm(again.body.departure.departMin)], [200, true, '11:33']);
    // /api/me에도 · 서버 계산(알림)도 그 시각 기준
    assert.equal((await req('GET', '/api/me')).body.departure.key, '2026-11-23:c1');
    assert.equal(departedMinFor(store.user('u22'), '2026-11-23', CLASS), 11 * 60 + 33);
    assert.equal(departedMinFor(store.user('u22'), '2026-11-24', CLASS), null, '다른 날');
    assert.equal(departedMinFor({ ...store.user('u22'), transit: { ...store.user('u22').transit, route: parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[1] } }, '2026-11-23', CLASS), null, '경로를 바꾸면 쓰지 않음');
    // 지우기: 다른 키는 404 · 맞는 키는 지움
    const wrong = await req('POST', '/api/me/departure/undo', { key: '2026-11-22:c1' });
    assert.deepEqual([wrong.status, wrong.body.kind], [404, 'not-found']);
    const undo = await req('POST', '/api/me/departure/undo', { key: '2026-11-23:c1' });
    assert.deepEqual([undo.status, undo.body.departure], [200, null]);
    assert.equal(store.user('u22').departure, null);
    // 수업 시작 뒤에는 받지 않음
    clock.t = kst('2026-11-23T13:01:00');
    assert.equal((await req('POST', '/api/me/departure', { classId: 'c1', pressedAt: clock.t.getTime(), sentAt: clock.t.getTime() })).body.kind, 'outside-window');
  } finally { await close(); }
});

test('누르면 그 수업의 출발 · 지각 알림을 그만 보냄(서버 스케줄러 계산) · 계산은 누른 시각 기준', async () => {
  const store = createStore(null);
  withTransit(store, 'a');
  store.update('a', (u) => { u.prefs.notify = true; });
  // 누르지 않았을 때 출발 알림이 걸리는 시각을 찾음(추천 출발 5분 전)
  const probe = await planFor(store.user('a'), provider, kst('2026-11-23T11:00:00'));
  assert.equal(probe.rec.state, 'ok');
  const dep = probe.rec.pick.departMin, at = new Date(kst('2026-11-23T00:00:00').getTime() + (dep - 5) * 60_000);
  const before = await planFor(store.user('a'), provider, at);
  assert.ok(before.alarms.some((x) => x.type === 'depart'), '누르기 전: 출발 알림');
  store.update('a', (u) => { u.departure = { key: '2026-11-23:c1', at: at.toISOString(), departMin: dep - 30, routeKey: routeKey(ROUTE) }; });
  const after = await planFor(store.user('a'), provider, at);
  assert.deepEqual([after.alarms.length, after.departed, after.rec.departed, after.rec.pick.departMin], [0, true, true, dep - 30]);
  // 다른 날 기록은 무시 → 다시 알림
  store.update('a', (u) => { u.departure = { ...u.departure, key: '2026-11-22:c1' }; });
  assert.ok((await planFor(store.user('a'), provider, at)).alarms.length > 0);
});

test('환승 실시간 재료: 첫 지하철 실시간은 누른 시각 기준 시간대(출발 20분 뒤까지)만 부름', async () => {
  const calls = [];
  const subway = { arrivals: async (name) => { calls.push(name); return { source: 'seoul', station: name, rows: [], fetchedAt: new Date().toISOString() }; } };
  const cls = { ...CLASS };
  const nowDate = kst('2026-11-23T11:40:00'), nowMin = 11 * 60 + 40;
  // 누르지 않았으면 표준 계산 출발(13:00 수업 → 11시 넘어 추천)의 30분 전부터 → 11:40에는 부름
  await transitLive({ route: ROUTE, provider, subway, nowDate, cls, walkTable: {}, marginMin: 5 });
  assert.equal(calls.length, 1);
  // 10:50에 나갔다고 기록 → 11:40은 출발 50분 뒤라 첫 지하철 실시간은 그만
  const out = await transitLive({ route: ROUTE, provider, subway, nowDate, cls, walkTable: {}, marginMin: 5, departedMin: nowMin - 50 });
  assert.deepEqual([calls.length, out.first.source, out.first.reason], [1, 'skip', 'not-yet']);
});
