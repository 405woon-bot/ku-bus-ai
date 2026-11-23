// v2.2.5 '내 데이터 모두 삭제'(DELETE /api/me) 점검: 사용자 번호 · 확인 문구('삭제') 필수 · 공용 demo 거절 · 외부 DB를 다 읽기 전엔 거절 ·
//   외부 DB에서도 지워진 뒤에 성공 · 실패하면 503(다시 누르면 이어서 지움) · 다른 사용자는 그대로 · 이미 없으면 그대로 성공 ·
//   지운 직후 잠깐은 같은 번호의 쓰기 요청을 받지 않음(늦게 도착한 저장이 기록을 다시 만들지 않게). 가짜 Upstash만 씁니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createUpstash, upstashUsers } from '../src/upstash.js';
import { createRetention } from '../src/retention.js';
import { UPSTASH_URL, fakeUpstashFetch } from './fixtures/upstashFixture.js';

const quiet = { warn() {}, info() {}, error() {} };
const CLASS = { name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const provider = { name: 'mock', stopTrips: async () => ({ trips: [], source: 'mock' }), stopArrivals: async () => ({ arrivals: [] }), health: () => ({ provider: 'mock' }) };

async function server(store, extra = {}) {
  const app = createApp({ store, provider, pusher: { enabled: false, publicKey: null }, ...extra });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, uid) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(uid === undefined ? {} : { 'x-user-id': uid }) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { req, close: () => new Promise((r) => srv.close(r)) };
}

test('지우기: 확인 문구 · 사용자 번호가 있어야 하고 공용 demo는 거절 · 외부 DB에서도 지운 뒤에 성공 · 다른 사용자는 그대로 · 이미 없으면 그대로 성공', async () => {
  const data = {};
  const store = createStore(null, { remote: upstashUsers(createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) })), log: quiet });
  await store.ready;
  const retention = createRetention({ store, env: {}, log: quiet });
  const { req, close } = await server(store, { retention });
  try {
    const me = 'u0123456789abcdef0123456789abcdef', other = 'u3k9x2m1p';
    for (const id of [me, other, 'demo']) {
      await req('PUT', '/api/me/timetable', { classes: [CLASS] }, id);
      await req('PATCH', '/api/me', { stop: { arsId: '08901', name: '정릉시장' } }, id);
    }
    store.update(me, (u) => { u.push = [{ endpoint: 'https://push.example.invalid/me', keys: { p256dh: 'k', auth: 'a' } }]; u.arrivals = [{ key: 'x', at: 'y' }]; });
    await store.flush();
    assert.deepEqual(Object.keys(data['kubusai:users']).sort(), [me, other, 'demo'].sort());
    // 확인 문구 없음 · 틀림 · 헤더 없음 · 공용 demo
    assert.deepEqual((await req('DELETE', '/api/me', {}, me)).body.kind, 'confirm');
    assert.deepEqual((await req('DELETE', '/api/me', { confirm: '삭 제' }, me)).body.kind, 'confirm');
    assert.deepEqual((await req('DELETE', '/api/me', { confirm: '삭제' })).body.kind, 'no-user');
    const shared = await req('DELETE', '/api/me', { confirm: '삭제' }, 'demo');
    assert.deepEqual([shared.status, shared.body.kind], [400, 'shared']);
    assert.ok(store.peek(me) && store.peek('demo'), '거절한 요청은 아무것도 지우지 않음');
    // 지우기: 응답이 오면 외부 DB에서도 이미 없음
    const del = await req('DELETE', '/api/me', { confirm: ' 삭제 ' }, me);
    assert.deepEqual([del.status, del.body], [200, { ok: true, removed: true }]);
    assert.equal(data['kubusai:users'][me], undefined, '외부 DB에서 지운 뒤에 답함(기다림)');
    assert.equal(store.peek(me), undefined);
    assert.deepEqual(Object.keys(data['kubusai:users']).sort(), [other, 'demo'].sort(), '다른 사용자 · demo는 그대로');
    assert.equal(store.info().deleted, 1);
    // 지운 요청 뒤 '마지막 사용' 기록이 기록을 다시 만들지 않음 · 다시 눌러도(이미 없음) 그대로 성공
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.peek(me), undefined);
    assert.deepEqual((await req('DELETE', '/api/me', { confirm: '삭제' }, me)).body, { ok: true, removed: false });
    // 같은 번호로 다시 읽으면 빈 새 기록(외부 DB에는 저장하지 않음)
    const fresh = await req('GET', '/api/me', null, me);
    assert.deepEqual([fresh.body.classes, fresh.body.stop, fresh.body.pushSubscriptions], [[], null, 0]);
    await store.flush();
    assert.equal(data['kubusai:users'][me], undefined);
  } finally { await close(); store.stop(); }
});

test('외부 DB를 다 읽기 전이거나 지우기가 외부 DB에 반영되지 않으면 503 — 다시 누르면 이어서 지움', async () => {
  // ① 아직 못 읽음
  const down = createStore(null, { remote: { kind: 'upstash', loadAll: async () => { throw new Error('down'); }, saveMany: async () => {}, deleteMany: async () => {} }, log: quiet, readyWaitMs: 10, loadRetryMs: 60_000 });
  await down.ready;
  const a = await server(down);
  try {
    const r = await a.req('DELETE', '/api/me', { confirm: '삭제' }, 'u1');
    assert.deepEqual([r.status, r.body.kind], [503, 'not-ready']);
  } finally { await a.close(); down.stop(); }
  // ② 외부 DB 지우기가 실패(연결 끊김) → 503 · 그다음 다시 누르면 성공
  let failing = true;
  const deleted = [];
  const remote = { kind: 'upstash', loadAll: async () => ({ u2: { classes: [CLASS], updatedAt: 1 } }), saveMany: async () => {},
    deleteMany: async (ids) => { if (failing) throw new Error('network'); deleted.push(...ids); } };
  const store = createStore(null, { remote, log: quiet, retryMs: [60_000] });
  await store.ready;
  const b = await server(store);
  try {
    const r1 = await b.req('DELETE', '/api/me', { confirm: '삭제' }, 'u2');
    assert.deepEqual([r1.status, r1.body.kind, store.removalPending('u2')], [503, 'pending', true]);
    failing = false;
    const r2 = await b.req('DELETE', '/api/me', { confirm: '삭제' }, 'u2');
    assert.deepEqual([r2.status, r2.body.ok, deleted, store.removalPending('u2')], [200, true, ['u2'], false]);
  } finally { await b.close(); store.stop(); }
  // ③ 지우기를 못 하는 저장소면 지우지 않고 500
  const legacy = createStore(null, { remote: { kind: 'x', loadAll: async () => ({ u3: { classes: [], updatedAt: 1 } }), saveMany: async () => {} }, log: quiet });
  await legacy.ready;
  const c = await server(legacy);
  try {
    const r = await c.req('DELETE', '/api/me', { confirm: '삭제' }, 'u3');
    assert.deepEqual([r.status, r.body.kind, Boolean(legacy.peek('u3'))], [500, 'unsupported', true]);
  } finally { await c.close(); legacy.stop(); }
});

test('지운 직후 잠깐은 같은 번호의 쓰기를 받지 않음(지우기 전에 보낸 저장이 늦게 와도 다시 만들지 않음) — 읽기 · 지우기 재시도 · 다른 사용자는 그대로 · 시간이 지나면 다시 받음', async () => {
  const data = {};
  const store = createStore(null, { remote: upstashUsers(createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) })), log: quiet });
  await store.ready;
  const { req, close } = await server(store, { deletedHoldMs: 150 });
  try {
    const me = 'u00112233445566778899aabbccddeeff', other = 'u99887766554433221100ffeeddccbbaa';
    const STOP = { stop: { arsId: '08901', name: '정릉시장' } };
    for (const id of [me, other]) await req('PUT', '/api/me/timetable', { classes: [CLASS] }, id);
    assert.equal((await req('DELETE', '/api/me', { confirm: '삭제' }, me)).status, 200);
    // 지우기 전에 보낸 저장 · 시간표 · 알림 구독이 늦게 도착
    const late = [await req('PATCH', '/api/me', STOP, me), await req('PUT', '/api/me/timetable', { classes: [CLASS] }, me),
      await req('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example.invalid/late', keys: { p256dh: 'k', auth: 'a' } } }, me)];
    assert.deepEqual(late.map((r) => [r.status, r.body?.kind]), [[409, 'deleted'], [409, 'deleted'], [409, 'deleted']]);
    assert.equal(store.peek(me), undefined, '기록을 다시 만들지 않음');
    // 지우기 재시도 · 읽기(빈 기록, 외부 DB에 저장하지 않음)는 그대로 · 다른 사용자는 영향 없음
    assert.deepEqual((await req('DELETE', '/api/me', { confirm: '삭제' }, me)).body, { ok: true, removed: false });
    const read = await req('GET', '/api/me', null, me);
    assert.deepEqual([read.status, read.body.classes, read.body.stop], [200, [], null]);
    assert.equal((await req('PATCH', '/api/me', STOP, other)).status, 200);
    await store.flush();
    assert.equal(data['kubusai:users'][me], undefined);
    assert.ok(data['kubusai:users'][other]);
    // 시간이 지나면 다시 받음(같은 번호를 쓰던 다른 기기 — 확인 창에 안내한 대로 그 기기 설정이 다시 저장될 수 있음)
    await new Promise((r) => setTimeout(r, 220));
    assert.equal((await req('PATCH', '/api/me', STOP, me)).status, 200);
    assert.ok(store.peek(me));
  } finally { await close(); store.stop(); }
});
