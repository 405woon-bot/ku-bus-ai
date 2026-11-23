// v2.2.4 보관 기간 점검: 마지막 사용 후 90일이 지나면 서버의 사용자 기록 자동 삭제(배포 시점이 기존 사용자의 기산점).
//   마지막 사용 = 화면 요청(12시간에 한 번 기록) · 출발 알림 전달 · 알림 수신 확인. 메모리 저장소 · 가짜 Upstash만 씁니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createUpstash, upstashUsers } from '../src/upstash.js';
import { SEEN_STEP_MS, createRetention, retentionDays } from '../src/retention.js';
import { createScheduler } from '../src/scheduler.js';
import { sendAndLog } from '../src/push.js';
import { createMockProvider } from '../src/transit/index.js';
import { UPSTASH_URL, fakeUpstashFetch } from './fixtures/upstashFixture.js';

const quiet = { warn() {}, info() {}, error() {} };
const DAY = 86400_000, HOUR = 3600_000;
const T0 = Date.parse('2026-11-24T03:00:00Z');   // 예시 배포 시점
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const remoteStore = (data, clock, extra = {}) => createStore(null, { remote: upstashUsers(createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) })), log: quiet, clock, ...extra });
const ids = (data) => Object.keys(data['kubusai:users'] || {}).sort();
const tick = () => new Promise((r) => setTimeout(r, 30));

test('RETENTION_DAYS: 비우면 90 · 0이면 지우기 끔 · 30일보다 짧게는 30 · 이상한 값은 90 · 최대 3650', () => {
  assert.deepEqual([{}, { RETENTION_DAYS: '' }, { RETENTION_DAYS: '0' }, { RETENTION_DAYS: '7' }, { RETENTION_DAYS: '365' }, { RETENTION_DAYS: 'abc' }, { RETENTION_DAYS: '99999' }].map(retentionDays), [90, 90, 0, 30, 365, 90, 3650]);
  assert.equal(SEEN_STEP_MS, 12 * HOUR);
});

test('store: 만들지 않고 보기(peek) · 지우기(remove)는 외부 DB에서도(HDEL) · 지우는 사이 다시 저장하면 새 기록 · 지울 수 없는 외부 DB면 지우지 않음', async () => {
  const data = {};
  const store = remoteStore(data);
  await store.ready;
  store.update('p1', (u) => { u.classes = [CLASS]; });
  store.update('p2', (u) => { u.classes = [CLASS]; });
  await store.flush();
  assert.equal(store.peek('nope'), undefined);
  assert.equal(store.users().length, 2, 'peek은 새 기록을 만들지 않음');
  assert.deepEqual([store.remove('p1'), store.remove('nope'), store.peek('p1')], [true, false, undefined]);
  assert.equal(store.info().pending, 1);
  await store.flush();
  assert.deepEqual([ids(data), store.info().deleted, store.info().pending], [['p2'], 1, 0]);
  // 지운 뒤 같은 사람이 다시 와서 저장 → 예전 기록 없이 새 기록
  store.remove('p2');
  store.update('p2', (u) => { u.stop = { arsId: '08901', name: '정릉시장' }; });
  await store.flush();
  const back = JSON.parse(data['kubusai:users'].p2);
  assert.deepEqual([back.classes, back.stop.arsId], [[], '08901']);
  const legacy = createStore(null, { remote: { kind: 'x', loadAll: async () => ({ a: { classes: [], updatedAt: 1 } }), saveMany: async () => {} }, log: quiet });
  await legacy.ready;
  assert.equal(legacy.remove('a'), false, '지우기를 못 하는 외부 DB면 메모리에서도 지우지 않음');
  assert.ok(legacy.peek('a'));
  store.stop(); legacy.stop();
});

test('기존 사용자 보호: 처음 켜질 때(배포 시점) 저장된 사용자의 마지막 사용을 그 시각으로 채움 → 90일까지는 하나도 안 지워짐 · 마지막으로 바뀐 시각은 그대로 · 읽기만 한 빈 기록은 저장 안 함', async () => {
  const data = {};
  let t = T0 - 30 * DAY;
  const store = remoteStore(data, () => t);
  await store.ready;
  const nine = Array.from({ length: 9 }, (_, i) => `u${i + 1}abcdefg`);
  for (const id of nine) store.update(id, (u) => { u.classes = [CLASS]; u.stop = { arsId: '08901', name: '정릉시장' }; });
  await store.flush();
  t = T0;
  store.user('viewer'); // 화면이 읽기만 한 사람(저장된 것 없음)
  const r = createRetention({ store, env: {}, clock: () => t, log: quiet });
  assert.deepEqual(await r.run(), { backfilled: 9, deleted: 0 });
  for (const id of nine) assert.deepEqual([store.peek(id).lastSeen, store.peek(id).updatedAt], [T0, T0 - 30 * DAY], id);
  await store.flush();
  assert.deepEqual(ids(data), nine.slice().sort(), "읽기만 한 'viewer'는 저장되지 않음");
  assert.equal(JSON.parse(data['kubusai:users'][nine[0]]).lastSeen, T0, '기산점은 외부 DB에도');
  let h = r.health();
  assert.deepEqual([h.days, h.on, h.users, h.dueNow, h.nextDueAt, h.active7, h.held, h.deletedTotal, h.backfilled], [90, true, 9, 0, new Date(T0 + 90 * DAY).toISOString(), 9, null, 0, 9]);
  assert.ok(!JSON.stringify(h).includes('u1abcdefg'), 'health에 사용자 ID 없음');
  // 다시 켜져도 기산점은 바뀌지 않음
  t = T0 + 10 * DAY;
  assert.deepEqual(await createRetention({ store, env: {}, clock: () => t, log: quiet }).run(), { backfilled: 0, deleted: 0 });
  assert.equal(store.peek(nine[0]).lastSeen, T0);
  // 딱 90일: 아직 안 지움
  t = T0 + 90 * DAY;
  assert.deepEqual(await r.run(), { backfilled: 0, deleted: 0 });
  // 90일 + 1시간: 9명 모두 대상 → 한 번에 절반 넘게 지워질 상황이라 멈춤(사람이 확인)
  t = T0 + 90 * DAY + HOUR;
  assert.deepEqual(await r.run(), { held: true, backfilled: 0, deleted: 0 });
  h = r.health();
  assert.deepEqual([h.dueNow, h.held.reason, h.held.due, h.held.users, store.users().filter(([id]) => nine.includes(id)).length], [9, 'bulk', 9, 9, 9]);
  // 확인 뒤 RETENTION_BULK_OK=1 → 진행 · 외부 DB에서도 지움
  const ok = createRetention({ store, env: { RETENTION_BULK_OK: '1' }, clock: () => t, log: quiet });
  assert.deepEqual(await ok.run(), { backfilled: 0, deleted: 9 });
  await store.flush();
  assert.deepEqual([ids(data), ok.health().deletedTotal, ok.health().lastDeleted.count, ok.health().users], [[], 9, 9, 0]);
  store.stop();
});

test("90일 지난 사용자만 지움(쓰는 사용자는 남음) · 공용 'demo'도 기한이 지나면 지움 · 다시 오면 새 기록으로 시작", async () => {
  const data = {};
  let t = T0 - DAY;
  const store = remoteStore(data, () => t);
  await store.ready;
  for (const id of ['a', 'b', 'c', 'd', 'demo']) store.update(id, (u) => { u.classes = [CLASS]; });
  t = T0;
  const r = createRetention({ store, env: {}, clock: () => t, log: quiet });
  await r.run();
  t = T0 + 40 * DAY;
  assert.deepEqual([r.touch('a'), r.touch('b'), r.touch('demo')], [true, true, false], "'demo'는 쓰는 것으로 세지 않음");
  t = T0 + 91 * DAY;
  assert.deepEqual(await r.run(), { backfilled: 0, deleted: 3 });
  await store.flush();
  assert.deepEqual(ids(data), ['a', 'b']);
  const h = r.health();
  assert.deepEqual([h.users, h.dueNow, h.nextDueAt, h.lastDeleted.count], [2, 0, new Date(T0 + 130 * DAY).toISOString(), 3]);
  // 'c'가 다시 앱을 열면 빈 새 기록(예전 시간표 없음)
  assert.deepEqual(store.user('c').classes, []);
  store.stop();
});

test('마지막 사용 기록: 화면 요청(저장된 사용자 · 12시간에 한 번 · 마지막으로 바뀐 시각은 그대로) · 알림 수신 확인 — demo · 헤더 없는 요청은 세지 않음', async () => {
  let t = T0;
  const store = createStore(null, { clock: () => t });
  const retention = createRetention({ store, env: {}, clock: () => t, log: quiet });
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false, publicKey: null }, now: () => new Date(t), retention });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, uid) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(uid ? { 'x-user-id': uid } : {}) }, body: body && JSON.stringify(body) });
    await r.json().catch(() => null); await tick();
    return r.status;
  };
  try {
    await req('GET', '/api/me', null, 'n1');
    assert.equal(store.peek('n1').lastSeen, null, '저장한 것이 없으면 기록하지 않음(외부 DB에 빈 기록을 만들지 않게)');
    await req('PUT', '/api/me/timetable', { classes: [CLASS] }, 'n1');
    const saved = store.peek('n1').updatedAt;
    assert.deepEqual([store.peek('n1').lastSeen, saved], [T0, T0], '저장하는 요청이 끝나면 바로 기록');
    t = T0 + 11 * HOUR;
    await req('GET', '/api/me', null, 'n1');
    assert.equal(store.peek('n1').lastSeen, T0, '12시간 안에는 다시 쓰지 않음');
    t = T0 + 13 * HOUR;
    await req('GET', '/api/plan', null, 'n1');
    assert.deepEqual([store.peek('n1').lastSeen, store.peek('n1').updatedAt], [T0 + 13 * HOUR, saved], '마지막으로 바뀐 시각은 그대로');
    // 공용 'demo' · 헤더 없는 요청(cron 깨우기 · 상태 확인)은 세지 않음
    store.update('demo', (u) => { u.classes = [CLASS]; });
    await req('GET', '/api/me', null, 'demo');
    await req('GET', '/api/wake');
    await req('GET', '/api/health');
    assert.equal(store.peek('demo').lastSeen, null);
    // 휴대폰이 알림을 받았다고 알림(서비스 워커 — 헤더 없음) = 사용
    store.update('n1', (u) => { u.pushLog = [{ id: 'ack1234567', kind: 'alarm', title: 'x', sentAt: t, sent: 1, failed: 0, ackAt: null }]; });
    t = T0 + 20 * DAY;
    assert.equal(await req('POST', '/api/push/ack', { id: 'ack1234567', endpoint: null }), 200);
    assert.equal(store.peek('n1').lastSeen, T0 + 20 * DAY);
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual([h.retention.days, h.retention.users, h.retention.dueNow, h.retention.held], [90, 2, 0, null]);
  } finally { await new Promise((r) => srv.close(r)); }
});

test('출발 알림이 휴대폰에 전달되면(알림 서버가 받음) 사용으로 셈 — 앱을 열지 않고 알림만 받는 사용자도 남음 · 실패 · 테스트 알림 · demo는 세지 않음', async () => {
  let t = T0;
  const store = createStore(null, { clock: () => t });
  const sub = { endpoint: 'https://push.example.invalid/1', keys: { p256dh: 'k', auth: 'a' } };
  for (const id of ['al', 'demo']) store.update(id, (u) => { u.classes = [CLASS]; u.push = [{ ...sub }]; });
  const okPusher = { enabled: true, deliver: async () => ({ results: [{ endpoint: sub.endpoint, ok: true, status: 201 }] }) };
  const badPusher = { enabled: true, deliver: async () => ({ results: [{ endpoint: sub.endpoint, ok: false, status: 500 }] }) };
  await sendAndLog(store, 'al', badPusher, [sub], { title: 'x' }, { kind: 'alarm', now: T0 + HOUR });
  assert.equal(store.peek('al').lastSeen, null, '전달 실패는 세지 않음');
  await sendAndLog(store, 'al', okPusher, [sub], { title: 'x' }, { kind: 'test', now: T0 + 2 * HOUR });
  assert.equal(store.peek('al').lastSeen, null, '테스트 알림은 화면 요청으로 이미 셈');
  await sendAndLog(store, 'al', okPusher, [sub], { title: 'x' }, { kind: 'alarm', now: T0 + 3 * HOUR });
  assert.equal(store.peek('al').lastSeen, T0 + 3 * HOUR);
  await sendAndLog(store, 'demo', okPusher, [sub], { title: 'x' }, { kind: 'alarm', now: T0 + 3 * HOUR });
  assert.equal(store.peek('demo').lastSeen, null);
});

test('스케줄러: 알림을 계산 · 보내는 사이 지워진 사용자(자동 삭제)는 기록을 다시 만들지 않음 · 지워지지 않았으면 그대로 보내고 사용으로 셈', async () => {
  const mk = () => {
    const store = createStore(null);
    store.update('z', (u) => { u.classes = [CLASS]; u.stop = { arsId: '08901', name: '정릉시장' }; u.push = [{ endpoint: 'https://push.example.invalid/z', keys: { p256dh: 'k', auth: 'a' } }]; });
    let open; const gate = new Promise((r) => { open = r; });
    const base = createMockProvider('jeongneung');
    const provider = { ...base, stopTrips: async (...a) => { await gate; return base.stopTrips(...a); } };
    const pushes = [];
    const pusher = { enabled: true, deliver: async (subs, p) => { pushes.push(p); return { results: subs.map((s) => ({ endpoint: s.endpoint, ok: true, status: 201 })) }; } };
    const t = new Date(Date.UTC(2026, 10, 8, 23, 25)); // 서울 월 08:25(출발 알림 시각)
    const s = createScheduler({ store, provider, pusher, now: () => t, log: quiet });
    return { store, s, open, pushes, t };
  };
  const a = mk();
  const run = a.s.tick();
  await tick();
  assert.equal(a.store.remove('z'), true); // 계산하는 사이 90일 자동 삭제
  a.open();
  assert.deepEqual(await run, []);
  assert.deepEqual([a.store.peek('z'), a.pushes.length], [undefined, 0], '지워진 사용자에게 보내지도, 기록을 만들지도 않음');
  const b = mk();
  const run2 = b.s.tick();
  b.open();
  const sent = await run2;
  assert.deepEqual([sent.length, b.pushes.length, b.store.peek('z').lastSeen], [1, 1, b.t.getTime()]);
});

test('안전장치: 외부 DB를 다 읽기 전에는 아무것도 안 함 · 마지막 사용이 미래인 기록은 안 지움 · RETENTION_DAYS=0이면 끔 · 한 번에 최대 20명', async () => {
  const down = createStore(null, { remote: { kind: 'upstash', loadAll: async () => { throw new Error('down'); }, saveMany: async () => {}, deleteMany: async () => {} }, log: quiet, readyWaitMs: 10, loadRetryMs: 60_000 });
  await down.ready;
  const w = createRetention({ store: down, env: {}, clock: () => T0 + 400 * DAY, log: quiet });
  assert.deepEqual(await w.run(), { waiting: true });
  down.stop();

  let t = T0;
  const store = createStore(null, { clock: () => t });
  for (let i = 0; i < 25; i++) store.update(`m${i}`, (u) => { u.classes = [CLASS]; });
  store.update('future', (u) => { u.classes = [CLASS]; });
  const off = createRetention({ store, env: { RETENTION_DAYS: '0' }, clock: () => t, log: quiet });
  assert.deepEqual(await off.run(), { off: true, backfilled: 26, deleted: 0 });
  store.peek('future').lastSeen = T0 + 400 * DAY; // 시계가 이상했던 기록
  t = T0 + 200 * DAY;
  assert.deepEqual(await off.run(), { off: true, backfilled: 0, deleted: 0 });
  assert.deepEqual([off.health().on, off.health().dueNow, off.health().nextDueAt], [false, 0, null]);
  const r = createRetention({ store, env: { RETENTION_BULK_OK: 'yes' }, clock: () => t, log: quiet });
  assert.deepEqual(await r.run(), { backfilled: 0, deleted: 20 }, '한 번에 최대 20명');
  assert.deepEqual(await r.run(), { backfilled: 0, deleted: 5 });
  assert.deepEqual([store.users().map(([id]) => id), r.health().future], [['future'], 1], '미래 시각 기록은 남김');
});

test('켜질 때: 외부 DB를 늦게 읽어도 1분 뒤 다시 확인해 기산점을 채움 · 멈추면 더 돌지 않음', async () => {
  let loaded = false;
  const store = createStore(null);
  store.update('late', (u) => { u.classes = [CLASS]; });
  const orig = store.info.bind(store);
  store.info = () => ({ ...orig(), loaded });
  const r = createRetention({ store, env: {}, clock: () => T0, log: quiet, retryMs: 20, intervalMs: 3600_000 });
  r.start();
  await tick();
  assert.equal(store.peek('late').lastSeen, null, '읽기 전에는 아무것도 안 함');
  loaded = true;
  for (let i = 0; i < 20 && store.peek('late').lastSeen !== T0; i++) await tick();
  r.stop();
  assert.deepEqual([store.peek('late').lastSeen, r.health().noLastSeen], [T0, 0]);
});
