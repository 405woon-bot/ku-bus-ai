import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';
import { createStore } from '../src/store.js';
import { createMockProvider } from '../src/transit/index.js';

test('스케줄러: 지연 조기 알림 1회 → 출발 10분 전 알림 1회, 중복 없음', async () => {
  const store = createStore(null); store.user('demo');
  const pushes = [];
  const pusher = { enabled: true, send: async (subs, p) => { pushes.push(p.title); return []; } };
  let t = new Date('2026-11-08T23:10:00Z'); // 서울 월 08:10
  const s = createScheduler({ store, provider: createMockProvider('jeongneung'), pusher, now: () => t, log: { warn() {} } });
  const at = async (hhmm) => { const [h, m] = hhmm.split(':').map(Number); t = new Date(Date.UTC(2026, 10, 8, h + 15, m)); return (await s.tick()).map((x) => x.type); };
  assert.deepEqual(await at('08:10'), ['delay']);
  assert.deepEqual(await at('08:15'), []);
  assert.deepEqual(await at('08:21'), ['depart']);
  assert.deepEqual(await at('08:22'), []);
  assert.deepEqual(await at('09:05'), []); // 수업 시작 후
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1], '10분 뒤 출발하세요 (08:31)');
});

/* ── v0.3: 서울시 실시간으로 계산한 푸시, 예시 데이터 표시 ── */
import { createLiveService } from '../src/transit/index.js';
import { MOCK_NOTE } from '../src/scheduler.js';
import { USER_ROUTES, fakeSeoulFetch } from './fixtures/seoulFixture.js';

function setup({ key = 'TESTKEY', pushWhenMock = 'label' } = {}) {
  const store = createStore(null);
  store.update('demo', (u) => { u.routes = USER_ROUTES.map((r) => ({ ...r })); });
  const fetchImpl = fakeSeoulFetch();
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: key }, fetchImpl, background: false, log: { warn() {}, info() {} } });
  const pushes = [];
  const pusher = { enabled: true, send: async (_s, p) => { pushes.push(p); return []; } };
  let t = new Date('2026-11-08T23:10:00Z');
  const s = createScheduler({ store, provider, pusher, now: () => t, pushWhenMock, log: { warn() {} } });
  const at = async (hhmm) => { const [h, m] = hhmm.split(':').map(Number); t = new Date(Date.UTC(2026, 10, 8, h + 15, m)); return s.tick(); };
  return { at, pushes, fetchImpl, s };
}

test('스케줄러(서울시 실시간): 08:10 지연 알림에 실제 정체 원인, 출처 seoul', async () => {
  const { at, pushes } = setup();
  const sent = await at('08:10');
  assert.deepEqual(sent.map((x) => [x.type, x.source]), [['delay', 'seoul']]);
  assert.equal(pushes[0].title, '지연 알림 · 171번 +6분');
  assert.match(pushes[0].body, /^현재 정릉로 정체로 171번 6분 지연! 8:33까지 출발을 권장합니다/);
  assert.ok(!pushes[0].body.includes(MOCK_NOTE));
  assert.deepEqual((await at('08:23')).map((x) => x.type), ['depart']); // 08:33 − 10분
});

test('스케줄러: 예시 데이터로 계산한 알림은 본문에 출처 표시, PUSH_WHEN_MOCK=skip이면 보내지 않음, 시간대 밖에서는 API 호출 없음', async () => {
  const a = setup({ key: '' });
  await a.at('08:10');
  assert.ok(a.pushes.length >= 1 && a.pushes.every((p) => p.body.endsWith(MOCK_NOTE) && p.source === 'mock'));
  const b = setup({ key: '', pushWhenMock: 'skip' });
  assert.deepEqual(await b.at('08:10'), []);
  assert.equal(b.s.status().skippedMock > 0, true);
  const c = setup();
  await c.at('05:30');          // 09:00 수업의 3시간 전보다 이름
  assert.equal(c.fetchImpl.calls.length, 0);
});

test('스케줄러: 예시 데이터로 보낸 지연 알림 뒤 서울시 실시간이 돌아오면 실제 값으로 다시 판단', async () => {
  const store = createStore(null);
  store.update('demo', (u) => { u.routes = USER_ROUTES.map((r) => ({ ...r })); });
  let down = true;
  const ok = fakeSeoulFetch();
  const fetchImpl = async (url, o) => { if (down) throw new Error('ENOTFOUND'); return ok(url, o); };
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'K' }, fetchImpl, background: false, log: { warn() {}, info() {} } });
  const pushes = [];
  const pusher = { enabled: true, send: async (_s, p) => { pushes.push(p); return []; } };
  let t = new Date('2026-11-08T23:10:00Z');
  const s = createScheduler({ store, provider, pusher, now: () => t, log: { warn() {} } });
  assert.deepEqual((await s.tick()).map((x) => [x.type, x.source]), [['delay', 'mock']]);
  assert.ok(pushes[0].body.endsWith(MOCK_NOTE));
  down = false; t = new Date('2026-11-08T23:11:00Z');
  assert.deepEqual((await s.tick()).map((x) => [x.type, x.source]), [['delay', 'seoul']]);
  assert.match(pushes[1].title, /171번 \+6분/);
  assert.deepEqual(await s.tick(), []); // 같은 분에 다시 돌려도 중복 없음
});
