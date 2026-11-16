// 외부 DB(Upstash Redis REST) 저장소: 요청 모양 · 시작할 때 읽기 · 바뀐 사용자만 모아 저장 · 재시작해도 그대로 · 실패해도 앱은 그대로 · 토큰 보호
// 가짜 Upstash(test/fixtures/upstashFixture.js)만 씁니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { UpstashError, createUpstash, pairsToObject, upstashUsers } from '../src/upstash.js';
import { createStore, createStoreFromEnv, tidyUser } from '../src/store.js';
import { UPSTASH_URL, fakeUpstashFetch } from './fixtures/upstashFixture.js';

const TOKEN = 'UPSTASH-TEST-TOKEN';
const quiet = { warn() {}, info() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (o = {}) => ({ UPSTASH_REDIS_REST_URL: UPSTASH_URL, UPSTASH_REDIS_REST_TOKEN: TOKEN, ...o });

test('Upstash REST 요청: 주소에 명령을 POST(JSON 배열) · 토큰은 Authorization: Bearer 헤더로만 · 결과/오류 해석', async () => {
  const fetchImpl = fakeUpstashFetch();
  const c = createUpstash({ url: `${UPSTASH_URL}/`, token: TOKEN, fetchImpl });
  assert.equal(c.configured, true);
  assert.equal(await c.cmd('HSET', 'k', 'a', 1), 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url.href, `${UPSTASH_URL}/`);
  assert.equal(call.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(call.body, ['HSET', 'k', 'a', '1'], '인자는 글자로');
  assert.ok(!call.url.href.includes(TOKEN), '주소에 토큰을 넣지 않음');
  assert.deepEqual(pairsToObject(await c.cmd('HGETALL', 'k')), { a: '1' });
  assert.deepEqual(await c.pipeline([['PING'], ['HGETALL', 'k']]), ['PONG', ['a', '1']]);
  assert.equal(fetchImpl.calls[2].url.pathname, '/pipeline');
  await assert.rejects(c.cmd('NOPE'), (e) => e instanceof UpstashError && e.kind === 'command');
  // 토큰 틀림 · 읽기 전용 토큰 · 서버 오류 · 시간 초과 · 연결 실패
  await assert.rejects(createUpstash({ url: UPSTASH_URL, token: 'WRONG', fetchImpl }).cmd('PING'), (e) => e.kind === 'auth' && /UPSTASH_REDIS_REST_TOKEN/.test(e.message) && !e.message.includes('WRONG'));
  await assert.rejects(createUpstash({ url: UPSTASH_URL, token: TOKEN, fetchImpl: fakeUpstashFetch({ readonly: true }) }).cmd('HSET', 'k', 'a', '1'), (e) => e.kind === 'auth');
  const down = fakeUpstashFetch({ fail: () => ({ ok: false, status: 503, text: async () => 'unavailable' }) });
  await assert.rejects(createUpstash({ url: UPSTASH_URL, token: TOKEN, fetchImpl: down }).cmd('PING'), (e) => e.kind === 'server');
  const slow = async (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(createUpstash({ url: UPSTASH_URL, token: TOKEN, fetchImpl: slow, timeoutMs: 50 }).cmd('PING'), (e) => e.kind === 'timeout');
  await assert.rejects(createUpstash({ url: UPSTASH_URL, token: TOKEN, fetchImpl: async () => { throw new TypeError(`fetch failed ${TOKEN}`); } }).cmd('PING'),
    (e) => e.kind === 'network' && !e.message.includes(TOKEN));
  assert.deepEqual(pairsToObject({ x: '1' }), { x: '1' });
  assert.deepEqual(pairsToObject(null), {});
});

test('사용자 기록: 해시 하나(kubusai:users)에 사용자마다 JSON, 깨진 값은 건너뜀', async () => {
  const fetchImpl = fakeUpstashFetch({ data: { 'kubusai:users': { u1: JSON.stringify({ classes: [1], stop: { arsId: '08901' } }), bad: '{not json' } } });
  const r = upstashUsers(createUpstash({ url: UPSTASH_URL, token: TOKEN, fetchImpl }));
  assert.deepEqual(Object.keys(await r.loadAll()), ['u1']);
  await r.saveMany([['u2', { a: 1 }], ['u3', { b: 2 }]]);
  assert.deepEqual(fetchImpl.calls.at(-1).body, ['HSET', 'kubusai:users', 'u2', '{"a":1}', 'u3', '{"b":2}'], '여러 명을 명령 하나로');
  await r.saveMany([]);
  assert.equal(fetchImpl.calls.length, 2, '저장할 것이 없으면 부르지 않음');
});

test('시작할 때 다 읽고(ready), 바뀐 사용자만 0.3초 모아 저장 → 서버를 다시 켜도(새 저장소) 그대로', async () => {
  const fetchImpl = fakeUpstashFetch();
  const a = createStoreFromEnv(env(), { fetchImpl, log: quiet });
  await a.ready;
  assert.deepEqual([a.info().kind, a.info().loaded, a.info().users], ['upstash', true, 0]);
  a.user('reader'); // 읽기만 한 사용자는 저장하지 않음
  a.update('u1', (u) => { u.stop = { arsId: '08901', name: '정릉시장' }; u.classes = [{ id: 'c1', name: '자료구조' }]; });
  a.update('u1', (u) => { u.prefs.walkToStopMin = 7; });
  a.update('u2', (u) => { u.push = [{ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }]; });
  assert.equal(a.info().pending, 2);
  await wait(450);
  const hsets = fetchImpl.calls.filter((c) => c.body[0] === 'HSET');
  assert.equal(hsets.length, 1, '0.3초 안의 변경은 한 번에');
  assert.deepEqual(Object.keys(fetchImpl.db['kubusai:users']).sort(), ['u1', 'u2']);
  assert.deepEqual([a.info().pending, a.info().saves], [0, 1]);
  // 서버가 잠들었다 깨어남(새 저장소)
  const b = createStoreFromEnv(env(), { fetchImpl, log: quiet });
  await b.ready;
  assert.deepEqual([b.info().users, b.user('u1').stop.name, b.user('u1').prefs.walkToStopMin, b.user('u2').push.length], [2, '정릉시장', 7, 1]);
  a.stop(); b.stop();
});

test('외부 DB를 못 읽으면: 메모리로 열고(저장은 미룸) 다시 읽기 → 읽은 뒤 더 새로 바뀐 사용자만 남기고 저장', async () => {
  let down = true;
  const fetchImpl = fakeUpstashFetch({
    data: { 'kubusai:users': { old: JSON.stringify({ classes: [], stop: { arsId: '11111', name: 'DB의 값' }, updatedAt: 1 }), kept: JSON.stringify({ classes: [], stop: { arsId: '22222', name: 'DB만 아는 사용자' }, updatedAt: 1 }) } },
    fail: () => (down ? { ok: false, status: 503, text: async () => 'down' } : null),
  });
  const s = createStore(null, { remote: upstashUsers(createUpstash({ url: UPSTASH_URL, token: TOKEN, fetchImpl })), log: quiet, loadRetryMs: 80, retryMs: [50], flushMs: 20, clock: () => 1000 });
  await s.ready;
  assert.equal(s.info().loaded, false);
  assert.equal(s.info().lastError.op, 'load');
  s.user('old'); // 읽기 전 기본값으로 만들어진 사용자(바뀐 적 없음) → DB 값이 이김
  s.update('fresh', (u) => { u.stop = { arsId: '33333', name: '읽기 전에 저장' }; });
  await wait(120);
  assert.equal(fetchImpl.calls.filter((c) => c.body[0] === 'HSET').length, 0, '다 읽기 전에는 덮어쓰지 않음');
  down = false;
  await wait(200);
  assert.equal(s.info().loaded, true);
  assert.equal(s.info().lastError, null);
  assert.deepEqual([s.user('old').stop.name, s.user('kept').stop.name, s.user('fresh').stop.name], ['DB의 값', 'DB만 아는 사용자', '읽기 전에 저장']);
  await wait(120);
  assert.equal(JSON.parse(fetchImpl.db['kubusai:users'].fresh).stop.name, '읽기 전에 저장', '읽은 뒤 미뤄 둔 저장');
  s.stop();
});

test('저장 실패: 바뀐 것을 남겨 두고 간격을 늘려 다시 · 상태에 이유(토큰은 없음)', async () => {
  let fails = 2;
  const fetchImpl = fakeUpstashFetch({ fail: (cmd) => (cmd[0] === 'HSET' && fails-- > 0 ? { ok: false, status: 500, text: async () => JSON.stringify({ error: `boom ${TOKEN}` }) } : null) });
  const s = createStore(null, { remote: upstashUsers(createUpstash({ url: UPSTASH_URL, token: TOKEN, fetchImpl })), log: quiet, flushMs: 10, retryMs: [40, 40] });
  await s.ready;
  s.update('u1', (u) => { u.stop = { arsId: '08901', name: '정릉시장' }; });
  await wait(30);
  assert.equal(s.info().lastError.op, 'save');
  assert.ok(!JSON.stringify(s.info()).includes(TOKEN), '상태에 토큰이 남지 않음');
  assert.equal(s.info().pending, 1);
  await wait(150);
  assert.deepEqual([s.info().pending, s.info().lastError, Object.keys(fetchImpl.db['kubusai:users'] || {})], [0, null, ['u1']]);
  s.stop();
});

test('환경변수가 없으면 임시 파일 저장소 · 정리: 3일 지난 보낸 알림 기록 · 구독 5개 · 로그 8개', () => {
  const s = createStoreFromEnv({ DATA_FILE: path.join(os.tmpdir(), `kubus-test-${process.pid}.json`) }, { log: quiet });
  assert.deepEqual([s.info().kind, s.info().loaded], ['file', true]);
  assert.equal(createStoreFromEnv({ UPSTASH_REDIS_REST_URL: UPSTASH_URL }, { log: quiet }).info().kind, 'file', '주소 · 토큰이 둘 다 있어야 외부 DB');
  assert.equal(createStore(null).info().kind, 'memory');
  const u = { fired: { '2026-11-09:c1': {}, '2026-11-06:c1': {}, '2026-11-05:c1': {}, legacy: {} }, push: Array.from({ length: 7 }, (_, i) => ({ endpoint: `e${i}` })), pushLog: Array.from({ length: 11 }, (_, i) => ({ id: i })) };
  tidyUser(u);
  assert.deepEqual(Object.keys(u.fired).sort(), ['2026-11-06:c1', '2026-11-09:c1', 'legacy']);
  assert.deepEqual([u.push.length, u.push[0].endpoint, u.pushLog.length, u.pushLog[0].id], [5, 'e2', 8, 3]);
});
