// v2.8.0 점검(승인한 설계안): ① 알림 구독이 없거나 출발 알림을 끈 기록은 스케줄러가 계산 · 실시간 호출을 하지 않음
//   ② 앱을 열 때 같은 시간표를 다시 저장해도 '보낸 알림' 기록 그대로 → 같은 출발 알림이 1분 뒤 다시 가지 않음(v2.7.0까지의 문제 재현)
//   ③ 버전 번호: 받은 버전이 다르면 저장하지 않고 409 + 지금 값 · 같은 내용이면 성공 · baseRev 없는 예전 화면은 예전처럼
//   ④ 7일 쉬기: 앱을 연 것만 셈(lastOpenAt) · 쉬기 시작할 때 낮에 안내 알림 한 번 · 다시 열면 다음 1분부터 · 첫 7일(시작점)은 아무도 안 쉼
//   메모리 저장소 · 가짜 Upstash · 예시(모의) 버스 데이터만 씁니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';
import { createRetention } from '../src/retention.js';
import { NOTICE_HOURS, OPEN_STEP_MS, SLEEP_SINCE_KEY, createSleep, sleepDays, sleepNoticeText } from '../src/sleep.js';
import { createKv } from '../src/transit/kv.js';
import { createUpstash } from '../src/upstash.js';
import { createMockProvider } from '../src/transit/index.js';
import { UPSTASH_URL, fakeUpstashFetch } from './fixtures/upstashFixture.js';

const quiet = { warn() {}, info() {}, error() {} };
const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
/** 서울 2026-11-09(월)부터 d일 뒤 h:m (ms) */
const at = (d, h, m = 0) => Date.UTC(2026, 10, 9 + d, h - 9, m);
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const STOP = { arsId: '08901', name: '정릉시장' };
const SUB = (k) => ({ endpoint: `https://push.example.invalid/${k}`, keys: { p256dh: 'k', auth: 'a' } });
const ID = `u${'a'.repeat(32)}`;
const pause = () => new Promise((r) => setTimeout(r, 30));
/** 가짜 알림 서버: 받은 알림을 모으고, 구독마다 성공(ok) 또는 실패 */
const fakePusher = (sink, ok = true) => ({ enabled: true, publicKey: 'BPUB', deliver: async (subs, p) => { sink.push(p); return { results: subs.map((s) => ({ endpoint: s.endpoint, ok, status: ok ? 201 : 500 })) }; } });
/** 실시간 호출을 세는 예시 공급자 */
const countingProvider = (calls) => { const base = createMockProvider('jeongneung'); return { ...base, stopTrips: async (arsId, d) => { calls.push(arsId); return base.stopTrips(arsId, d); } }; };

async function withServer(app, fn) {
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, uid) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(uid ? { 'x-user-id': uid } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => null); await pause();
    return { status: r.status, body: j };
  };
  try { await fn(req); } finally { await new Promise((r) => srv.close(r)); }
}

test('스케줄러 ①: 알림 구독이 없거나 출발 알림을 끈 기록은 실시간을 부르지 않음 · 구독이 생기면 다음 1분부터 계산 · health 개수', async () => {
  const store = createStore(null);
  const calls = [], pushes = [];
  store.update('nopush', (u) => { u.classes = [CLASS]; u.stop = STOP; });
  store.update('off', (u) => { u.classes = [CLASS]; u.stop = STOP; u.push = [SUB('off')]; u.prefs.notify = false; });
  store.update('on', (u) => { u.classes = [CLASS]; u.stop = STOP; u.push = [SUB('on')]; });
  let t = at(0, 8, 25);
  const s = createScheduler({ store, provider: countingProvider(calls), pusher: fakePusher(pushes), now: () => new Date(t), log: quiet });
  const sent = await s.tick();
  assert.deepEqual(sent.map((x) => [x.userId, x.types]), [['on', ['depart']]]);
  assert.equal(calls.length, 1, '실시간은 구독이 있고 출발 알림을 켠 기록 하나만');
  assert.deepEqual(s.status().users, { total: 3, planned: 1, noPush: 1, notifyOff: 1, asleep: 0 });
  assert.deepEqual([store.peek('nopush').fired, store.peek('nopush').pushLog], [{}, []], '보낼 곳 없는 기록에는 알림 기록도 남기지 않음');
  // 구독이 생기면 다음 1분부터 계산 — 이미 지난 출발 알림도 그 기기로 한 번(예전에는 받을 곳 없이 '보냄'으로 적혀 못 받았음)
  store.update('nopush', (u) => { u.push = [SUB('nopush')]; });
  t = at(0, 8, 26);
  assert.deepEqual((await s.tick()).map((x) => x.userId), ['nopush']);
  assert.deepEqual(s.status().users, { total: 3, planned: 2, noPush: 0, notifyOff: 1, asleep: 0 });
  // health: scheduler.users(개수만) · 쉬기를 안 쓰는 서버면 sleep은 null
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false }, now: () => new Date(t), scheduler: s });
  await withServer(app, async (req) => {
    const h = (await req('GET', '/api/health')).body;
    assert.deepEqual([h.scheduler.users, h.scheduler.sleep], [{ total: 3, planned: 2, noPush: 0, notifyOff: 1, asleep: 0 }, null]);
    assert.ok(!JSON.stringify(h.scheduler).includes('nopush'), '사용자 번호는 싣지 않음');
  });
});

test('중복 출발 알림 막기 ②: 앱을 열 때 같은 시간표를 다시 저장해도(예전 화면) 보낸 알림 기록 그대로 → 다시 보내지 않음 · 시간표가 실제로 바뀌면 예전처럼 다시 계산', async () => {
  // v2.7.0까지: 08:25 '10분 뒤 출발하세요' → 08:27 같은 시간표 저장(알림 기록이 지워짐) → 08:28 '7분 뒤 출발하세요'가 또 갔음
  let t = at(0, 8, 25);
  const store = createStore(null, { clock: () => t });
  store.update(ID, (u) => { u.classes = [CLASS]; u.stop = STOP; u.push = [SUB('dup')]; });
  const pushes = [];
  const s = createScheduler({ store, provider: createMockProvider('jeongneung'), pusher: fakePusher(pushes), now: () => new Date(t), log: quiet });
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false }, now: () => new Date(t), scheduler: s });
  await withServer(app, async (req) => {
    await s.tick();
    assert.deepEqual(pushes.map((p) => p.title), ['10분 뒤 출발하세요 (08:35)']);
    const fired = JSON.stringify(store.peek(ID).fired), saved = store.peek(ID).updatedAt;
    // 08:27 알림을 눌러 앱을 엶 → 예전 화면은 받은 시간표를 그대로 다시 보냄(baseRev 없음)
    t = at(0, 8, 27);
    const me = (await req('GET', '/api/me', null, ID)).body;
    assert.deepEqual(me.rev, { timetable: 0, settings: 0 });
    const r = await req('PUT', '/api/me/timetable', { classes: me.classes }, ID);
    assert.deepEqual([r.status, r.body.unchanged, r.body.rev], [200, true, { timetable: 0, settings: 0 }]);
    assert.deepEqual([JSON.stringify(store.peek(ID).fired), store.peek(ID).updatedAt], [fired, saved], '보낸 알림 기록 · 마지막으로 바뀐 시각 그대로(저장하지 않음)');
    // 설정도 같은 값이면 저장하지 않음
    const p = await req('PATCH', '/api/me', { stop: me.stop, prefs: me.prefs, walkOverrides: me.walkOverrides }, ID);
    assert.deepEqual([p.status, p.body.unchanged, store.peek(ID).updatedAt], [200, true, saved]);
    t = at(0, 8, 28);
    assert.deepEqual(await s.tick(), []);
    assert.equal(pushes.length, 1, '같은 출발 알림을 다시 보내지 않음');
    // 시간표가 실제로 바뀌면(수업 하나 더) 알림 기록을 처음부터 → 오늘 출발 알림을 다시 계산해 보냄(예전 규칙 그대로)
    t = at(0, 8, 29);
    const r2 = await req('PUT', '/api/me/timetable', { classes: [...me.classes, { ...CLASS, id: 'c2', day: 2 }], baseRev: 0 }, ID);
    assert.deepEqual([r2.status, r2.body.unchanged, r2.body.rev], [200, undefined, { timetable: 1, settings: 0 }]);
    assert.deepEqual(store.peek(ID).fired, {});
    t = at(0, 8, 30);
    await s.tick();
    assert.deepEqual(pushes.map((x) => x.title), ['10분 뒤 출발하세요 (08:35)', '5분 뒤 출발하세요 (08:35)']);
  });
});

test('버전 번호 ③(시간표): 받은 버전이 다르면 저장하지 않고 409 + 지금 시간표 · 같은 내용이면 버전이 달라도 성공 · baseRev 없는 예전 화면 · 이상한 baseRev는 예전처럼 저장', async () => {
  const store = createStore(null);
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false }, now: () => new Date(at(0, 7)) });
  const C2 = { ...CLASS, id: 'c2', name: '운영체제', day: 1 }, C3 = { ...CLASS, id: 'c3', name: '알고리즘', day: 2 };
  await withServer(app, async (req) => {
    let r = await req('PUT', '/api/me/timetable', { classes: [CLASS], baseRev: 0 }, ID);
    assert.deepEqual([r.status, r.body.rev.timetable], [200, 1]);
    // 다른 화면(같은 번호)이 버전 1을 받아 하나 더 넣음 → 2
    r = await req('PUT', '/api/me/timetable', { classes: [CLASS, C2], baseRev: 1 }, ID);
    assert.deepEqual([r.status, r.body.rev.timetable], [200, 2]);
    // 오래 열어 둔 화면: 버전 1로 다른 내용 → 409 · 지금 시간표 · 서버는 그대로
    r = await req('PUT', '/api/me/timetable', { classes: [CLASS, C3], baseRev: 1 }, ID);
    assert.deepEqual([r.status, r.body.kind, r.body.section, r.body.rev, r.body.classes.map((c) => c.id)], [409, 'stale', 'timetable', { timetable: 2, settings: 0 }, ['c1', 'c2']]);
    assert.deepEqual(store.peek(ID).classes.map((c) => c.id), ['c1', 'c2']);
    // 내용이 서버와 같으면 버전이 달라도 성공(바꿀 것이 없음)
    r = await req('PUT', '/api/me/timetable', { classes: [CLASS, C2], baseRev: 1 }, ID);
    assert.deepEqual([r.status, r.body.unchanged, r.body.rev.timetable], [200, true, 2]);
    // baseRev 없는 예전 화면 · 이상한 baseRev는 확인하지 않고 예전처럼 저장(버전 +1)
    r = await req('PUT', '/api/me/timetable', { classes: [CLASS] }, ID);
    assert.deepEqual([r.status, r.body.rev.timetable], [200, 3]);
    for (const [i, bad] of ['1', -1, 1.5, null].entries()) {
      r = await req('PUT', '/api/me/timetable', { classes: i % 2 ? [CLASS] : [CLASS, C2], baseRev: bad }, ID);
      assert.equal(r.status, 200, String(bad));
    }
    assert.equal((await req('GET', '/api/me', null, ID)).body.rev.timetable, 7);
    // 수업 정보가 틀리면 지금처럼 400(버전과 상관없이)
    assert.equal((await req('PUT', '/api/me/timetable', { classes: [{ ...CLASS, name: '' }], baseRev: 0 }, ID)).status, 400);
    // 붙여 넣기로 넣은 시간표도 실제로 바뀌면 버전 +1
    r = await req('POST', '/api/me/timetable/import-text', { text: '알고리즘 화목 09:00-10:15 공학관 101', apply: true, replace: true }, ID);
    assert.equal(r.status, 200);
    assert.equal((await req('GET', '/api/me', null, ID)).body.rev.timetable, 8);
  });
});

test('버전 번호 ③(설정): 바뀌는 것이 없으면 저장하지 않음 · 다르면 409 + 지금 정류장 · 설정값 · 걷는 시간 · 정류장이 바뀌면 알림 기록을 처음부터(예전 규칙)', async () => {
  let t = at(0, 7);
  const store = createStore(null, { clock: () => t });
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false }, now: () => new Date(t) });
  await withServer(app, async (req) => {
    let r = await req('PATCH', '/api/me', { stop: STOP, baseRev: 0 }, ID);
    assert.deepEqual([r.status, r.body.rev], [200, { timetable: 0, settings: 1 }]);
    store.update(ID, (u) => { u.fired = { '2026-11-09:c1': { depart: { departMin: 500 } } }; });
    const saved = store.peek(ID).updatedAt;
    t += MIN;
    // 같은 값(예전 화면이 앱을 열 때 그대로 보냄) → 저장하지 않음 · 알림 기록 그대로
    const me = (await req('GET', '/api/me', null, ID)).body;
    r = await req('PATCH', '/api/me', { stop: me.stop, prefs: me.prefs, walkOverrides: me.walkOverrides }, ID);
    assert.deepEqual([r.status, r.body.unchanged, r.body.rev.settings, store.peek(ID).updatedAt, Object.keys(store.peek(ID).fired).length], [200, true, 1, saved, 1]);
    // 다른 화면이 여유를 10분으로(버전 1 → 2)
    r = await req('PATCH', '/api/me', { prefs: { marginMin: 10 }, baseRev: 1 }, ID);
    assert.deepEqual([r.status, r.body.rev.settings, store.peek(ID).prefs.marginMin], [200, 2, 10]);
    // 오래 열어 둔 화면이 버전 1로 알림 시각을 15분으로 → 409 · 지금 값(여유 10분) · 서버는 그대로
    r = await req('PATCH', '/api/me', { prefs: { ...me.prefs, notifyBeforeMin: 15 }, baseRev: 1 }, ID);
    assert.deepEqual([r.status, r.body.kind, r.body.section, r.body.prefs.marginMin, r.body.stop, r.body.walkOverrides], [409, 'stale', 'settings', 10, STOP, {}]);
    assert.equal(store.peek(ID).prefs.notifyBeforeMin, 10);
    // 범위 밖 값은 예전처럼 잘라서(같은 값으로 잘리면 바뀌는 것 없음)
    r = await req('PATCH', '/api/me', { prefs: { marginMin: 99 }, baseRev: 2 }, ID);
    assert.deepEqual([r.status, store.peek(ID).prefs.marginMin, r.body.rev.settings], [200, 30, 3]);
    r = await req('PATCH', '/api/me', { prefs: { marginMin: 45 }, baseRev: 3 }, ID);
    assert.deepEqual([r.status, r.body.unchanged], [200, true]);
    // 정류장이 바뀌면 알림 기록을 처음부터(예전 규칙) · 정류장 번호가 틀리면 지금처럼 400
    r = await req('PATCH', '/api/me', { stop: { arsId: '08920', name: '시청앞.덕수궁' }, baseRev: 3 }, ID);
    assert.deepEqual([r.status, store.peek(ID).fired, store.peek(ID).stop.arsId, r.body.rev.settings], [200, {}, '08920', 4]);
    assert.equal((await req('PATCH', '/api/me', { stop: { arsId: '12', name: 'x' } }, ID)).status, 400);
    // baseRev 없는 예전 화면은 예전처럼 저장
    r = await req('PATCH', '/api/me', { prefs: { notify: false } }, ID);
    assert.deepEqual([r.status, store.peek(ID).prefs.notify, r.body.rev.settings], [200, false, 5]);
  });
});

test('마지막 앱 열기(lastOpenAt): 화면 요청만 · 저장된 사용자만 · 12시간에 한 번 · 마지막으로 바뀐 시각 그대로 — cron 깨우기 · 상태 확인 · 알림 수신 확인은 안 셈 · lastSeen과 따로', async () => {
  let t = at(0, 7);
  const store = createStore(null, { clock: () => t });
  const sleep = createSleep({ store, env: {}, clock: () => t, log: quiet });
  const retention = createRetention({ store, env: {}, clock: () => t, log: quiet });
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false }, now: () => new Date(t), retention, sleep });
  const T = t;
  await withServer(app, async (req) => {
    await req('GET', '/api/me', null, ID);
    assert.equal(store.peek(ID).lastOpenAt, null, '저장한 것이 없으면 기록하지 않음');
    await req('PUT', '/api/me/timetable', { classes: [CLASS] }, ID);
    const saved = store.peek(ID).updatedAt;
    assert.equal(store.peek(ID).lastOpenAt, T);
    t = T + 11 * HOUR; await req('GET', '/api/me', null, ID);
    assert.equal(store.peek(ID).lastOpenAt, T, '12시간 안에는 다시 쓰지 않음');
    t = T + 13 * HOUR; await req('GET', '/api/plan', null, ID);
    assert.deepEqual([store.peek(ID).lastOpenAt, store.peek(ID).updatedAt], [T + 13 * HOUR, saved]);
    // 헤더 없는 요청(cron 깨우기 · 상태 확인)과 알림 수신 확인(서비스 워커)은 앱을 연 것이 아님 — 수신 확인은 90일 보관(lastSeen)에만
    store.update(ID, (u) => { u.pushLog = [{ id: 'ackv280abc', kind: 'alarm', title: 'x', sentAt: t, sent: 1, failed: 0, ackAt: null }]; });
    t = T + 3 * DAY;
    await req('GET', '/api/wake'); await req('GET', '/api/health');
    assert.equal((await req('POST', '/api/push/ack', { id: 'ackv280abc', endpoint: null })).status, 200);
    assert.deepEqual([store.peek(ID).lastOpenAt, store.peek(ID).lastSeen], [T + 13 * HOUR, T + 3 * DAY]);
    // 수신 확인으로 lastSeen이 방금 바뀌었어도, 앱을 열면 lastOpenAt은 따로 바로 기록(12시간 간격은 lastOpenAt 기준)
    t = T + 3 * DAY + HOUR; await req('GET', '/api/me', null, ID);
    assert.equal(store.peek(ID).lastOpenAt, T + 3 * DAY + HOUR);
  });
  assert.equal(OPEN_STEP_MS, 12 * HOUR);
});

test('SCHEDULER_SLEEP_DAYS · 시작점: 비우면 7 · 0이면 끔 · 3 ~ 90 · 이상한 값은 7 / 시작점은 외부 DB에 한 번만(다시 켜져도 그대로) · 못 읽으면 켜진 시각', async () => {
  assert.deepEqual([{}, { SCHEDULER_SLEEP_DAYS: '' }, { SCHEDULER_SLEEP_DAYS: '0' }, { SCHEDULER_SLEEP_DAYS: '-3' }, { SCHEDULER_SLEEP_DAYS: '1' }, { SCHEDULER_SLEEP_DAYS: '14' }, { SCHEDULER_SLEEP_DAYS: '365' }, { SCHEDULER_SLEEP_DAYS: 'week' }].map(sleepDays), [7, 7, 0, 0, 3, 14, 90, 7]);
  const store = createStore(null);
  const T0 = at(0, 7);
  // 외부 DB(가짜 Upstash): 처음 켜질 때 한 번만 저장(SET NX) → 5일 뒤 다시 켜져도 처음 시각
  const data = {};
  const upstash = createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) });
  const a = createSleep({ store, env: {}, kv: createKv({ upstash }), clock: () => T0, log: quiet });
  await a.ready;
  const b = createSleep({ store, env: {}, kv: createKv({ upstash }), clock: () => T0 + 5 * DAY, log: quiet });
  await b.ready;
  assert.deepEqual([a.health().since, b.health().since, b.health().sinceFrom, data[SLEEP_SINCE_KEY].$s], [new Date(T0).toISOString(), new Date(T0).toISOString(), 'upstash', String(T0)]);
  // 메모리 외부 DB도 같은 규칙
  const mem = createKv({ clock: () => T0 });
  const c = createSleep({ store, env: {}, kv: mem, clock: () => T0, log: quiet }); await c.ready;
  const d = createSleep({ store, env: {}, kv: mem, clock: () => T0 + DAY, log: quiet }); await d.ready;
  assert.deepEqual([d.health().since, d.health().sinceFrom], [new Date(T0).toISOString(), 'memory']);
  // 외부 DB를 못 읽으면 이 서버가 켜진 시각(더 늦음 = 덜 쉼) · 미래 값(시계가 이상한 값)도 무시
  const down = createSleep({ store, env: {}, kv: { kind: 'upstash', setnx: async () => { throw new Error('down'); }, get: async () => null }, clock: () => T0 + 2 * DAY, log: quiet });
  await down.ready;
  assert.deepEqual([down.health().since, down.health().sinceFrom], [new Date(T0 + 2 * DAY).toISOString(), 'start']);
  const future = createKv({ clock: () => T0 }); await future.set(SLEEP_SINCE_KEY, String(T0 + 30 * DAY));
  const e = createSleep({ store, env: {}, kv: future, clock: () => T0, log: quiet }); await e.ready;
  assert.deepEqual([e.health().since, e.health().sinceFrom], [new Date(T0).toISOString(), 'start']);
  assert.deepEqual(createSleep({ store, env: { SCHEDULER_SLEEP_DAYS: '0' }, clock: () => T0, log: quiet }).health().on, false);
});

test('7일 쉬기 ④: 앱을 7일 넘게 열지 않으면 실시간 · 계산 없음 · 낮에 안내 알림 한 번 · 다시 열면 다음 1분부터 계산 · health', async () => {
  let t = at(-20, 12);
  const store = createStore(null, { clock: () => t });
  const sleep = createSleep({ store, env: {}, clock: () => t, log: quiet }); // 시작점: 20일 전
  store.update(ID, (u) => { u.classes = [CLASS]; u.stop = STOP; u.push = [SUB('sl')]; u.lastOpenAt = at(-8, 20); });
  const calls = [], pushes = [];
  const s = createScheduler({ store, provider: countingProvider(calls), pusher: fakePusher(pushes), now: () => new Date(t), log: quiet, sleep });
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false }, now: () => new Date(t), scheduler: s, sleep });
  await withServer(app, async (req) => {
    // 일 20:00에 마지막으로 연 지 7일 → 쉼. 일 20:30(낮 시간 안): 안내 알림 한 번(교통 API 없이)
    t = at(-1, 20, 30);
    assert.deepEqual([sleep.asleep(store.peek(ID), t), sleep.lastOpenOf(store.peek(ID), t)], [true, at(-8, 20)]);
    await s.tick();
    assert.deepEqual(pushes.map((p) => [p.title, p.body, p.kind]), [[sleepNoticeText(7).title, sleepNoticeText(7).body, 'sleep']]);
    assert.equal(pushes[0].body, '7일 동안 앱을 열지 않아 서버가 출발 알림 계산을 멈췄어요. 앱을 한 번 열면 바로 다시 알려 드려요.');
    assert.deepEqual(store.peek(ID).sleepNotice, { at: t, sent: 1 });
    // 월 08:25(09:00 수업의 출발 알림 시각): 쉬는 중 → 실시간 호출 · 출발 알림 계산 없음 · 안내 알림도 다시 안 보냄
    t = at(0, 8, 25);
    assert.deepEqual(await s.tick(), [], '출발 알림 계산 없음');
    assert.equal(calls.length, 0);
    assert.deepEqual(s.status().users, { total: 1, planned: 0, noPush: 0, notifyOff: 0, asleep: 1 });
    t = at(0, 8, 26); await s.tick();
    assert.equal(pushes.length, 1, '쉬는 동안 안내 알림은 한 번만');
    const h = (await req('GET', '/api/health')).body;
    assert.deepEqual([h.scheduler.sleep.days, h.scheduler.sleep.on, h.scheduler.sleep.notices, h.scheduler.users.asleep], [7, true, 1, 1]);
    assert.equal(store.peek(ID).lastOpenAt, at(-8, 20), '상태 확인(헤더 없음)은 앱을 연 것이 아님');
    // 08:27 앱을 엶 → 바로 기록 → 08:28부터 다시 계산 · 출발 알림
    t = at(0, 8, 27);
    const me = (await req('GET', '/api/me', null, ID)).body;
    assert.equal(store.peek(ID).lastOpenAt, t);
    assert.ok(!('sleepNotice' in me), '내부 기록은 화면에 싣지 않음');
    t = at(0, 8, 28);
    const sent = await s.tick();
    assert.deepEqual([sent.map((x) => x.types), calls.length, s.status().users.planned], [[['depart']], 1, 1]);
    assert.match(pushes[1].title, /^7분 뒤 출발하세요/);
    // 다시 7일 동안 안 열면 다시 쉬고, 새 쉬기라 안내 알림도 다시 한 번
    t = at(7, 8); await s.tick();
    assert.deepEqual([pushes.length, s.status().users.asleep], [2, 0], '6일 23시간 33분 — 아직 안 쉼(계산함)');
    t = at(9, 12); await s.tick();
    assert.deepEqual([pushes.length, pushes[2].kind, s.status().users.asleep], [3, 'sleep', 1]);
  });
});

test('쉬기 안내 알림 규칙: 낮(09:00 ~ 21:00)에만 · 시간표 · 출발 알림 · 구독이 있을 때만 · 못 보냈으면 하루 뒤 한 번 더 · SCHEDULER_SLEEP_DAYS=0이면 안 쉼', async () => {
  let t = at(-30, 12);
  const store = createStore(null, { clock: () => t });
  const sleep = createSleep({ store, env: {}, clock: () => t, log: quiet });
  store.update('night', (u) => { u.classes = [CLASS]; u.stop = STOP; u.push = [SUB('n')]; u.lastOpenAt = at(-10, 12); });
  store.update('noclass', (u) => { u.stop = STOP; u.push = [SUB('c')]; u.lastOpenAt = at(-10, 12); });
  const pushes = [];
  const s = createScheduler({ store, provider: createMockProvider('jeongneung'), pusher: fakePusher(pushes), now: () => new Date(t), log: quiet, sleep });
  t = at(0, 22); await s.tick();
  assert.deepEqual([pushes.length, s.status().users.asleep], [0, 2], '밤에는 기다림');
  t = at(1, 8, 59); await s.tick();
  assert.equal(pushes.length, 0, '09:00 전');
  t = at(1, NOTICE_HOURS[0]); await s.tick();
  assert.deepEqual(pushes.length, 1, '09:00부터 — 시간표가 없는 기록은 쉬어도 알림이 갈 일이 없어 안내하지 않음');
  assert.equal(store.peek('noclass').sleepNotice, null);
  // 알림 서버가 하나도 받지 않음(실패) → 하루 뒤 한 번 더
  let t2 = at(-30, 12);
  const store2 = createStore(null, { clock: () => t2 });
  const sleep2 = createSleep({ store: store2, env: {}, clock: () => t2, log: quiet });
  store2.update('bad', (u) => { u.classes = [CLASS]; u.stop = STOP; u.push = [SUB('b')]; u.lastOpenAt = at(-10, 12); });
  const fails = [];
  const s2 = createScheduler({ store: store2, provider: createMockProvider('jeongneung'), pusher: fakePusher(fails, false), now: () => new Date(t2), log: quiet, sleep: sleep2 });
  t2 = at(0, 10); await s2.tick();
  t2 = at(0, 18); await s2.tick();
  assert.equal(fails.length, 1, '하루 안에는 다시 보내지 않음');
  t2 = at(1, 10); await s2.tick();
  assert.equal(fails.length, 2, '하루 뒤 한 번 더');
  // 끄면(0) 오래 안 열어도 계산
  let t3 = at(-30, 12);
  const store3 = createStore(null, { clock: () => t3 });
  const off = createSleep({ store: store3, env: { SCHEDULER_SLEEP_DAYS: '0' }, clock: () => t3, log: quiet });
  store3.update('x', (u) => { u.classes = [CLASS]; u.stop = STOP; u.push = [SUB('x')]; u.lastOpenAt = at(-25, 12); });
  const p3 = [];
  const s3 = createScheduler({ store: store3, provider: createMockProvider('jeongneung'), pusher: fakePusher(p3), now: () => new Date(t3), log: quiet, sleep: off });
  t3 = at(0, 8, 25);
  assert.deepEqual((await s3.tick()).map((x) => x.types), [['depart']]);
  assert.equal(s3.status().users.asleep, 0);
});

test('첫 7일(시작점): 배포 전부터 있던 기록(lastOpenAt 없음)은 시작점부터 셈 → 7일 동안은 안 쉼 · 배포할 때 기존 기록은 다시 쓰지 않음', async () => {
  const T0 = at(-3, 15); // 예시 배포 시각(월요일 3일 전)
  let t = T0;
  const data = { 'kubusai:users': { old: JSON.stringify({ classes: [CLASS], stop: STOP, push: [SUB('o')], prefs: { notify: true, walkToStopMin: 5, marginMin: 5, notifyBeforeMin: 10 }, fired: {}, updatedAt: at(-60, 12), lastSeen: at(-50, 12) }) } };
  const before = data['kubusai:users'].old;
  const upstash = createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) });
  const { upstashUsers } = await import('../src/upstash.js');
  const store = createStore(null, { remote: upstashUsers(upstash), log: quiet, clock: () => t });
  await store.ready;
  const sleep = createSleep({ store, env: {}, kv: createKv({ upstash }), clock: () => t, log: quiet });
  await sleep.ready;
  await store.flush();
  assert.equal(data['kubusai:users'].old, before, '켜질 때 기존 기록을 다시 쓰지 않음');
  const u = store.peek('old');
  assert.equal(u.lastOpenAt, undefined);
  assert.deepEqual([sleep.lastOpenOf(u, T0 + DAY), sleep.asleep(u, T0 + 6 * DAY), sleep.asleep(u, T0 + 7 * DAY), sleep.asleep(u, T0 + 7 * DAY + MIN)], [T0, false, false, true]);
  // 다시 켜져도(재배포) 시작점은 처음 그대로
  t = T0 + 4 * DAY;
  const again = createSleep({ store, env: {}, kv: createKv({ upstash }), clock: () => t, log: quiet });
  await again.ready;
  assert.equal(again.lastOpenOf(u, t), T0);
  store.stop();
});

test('.env.example: SCHEDULER_SLEEP_DAYS는 값 없이 설명만', () => {
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^SCHEDULER_SLEEP_DAYS=$/m);
});
