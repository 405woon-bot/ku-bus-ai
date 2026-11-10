// 서버 스케줄러: 탑승 정류장 기준 추천 → 출발 알림 Web Push (화면과 같은 shared/recommend.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_NOTE, createScheduler } from '../src/scheduler.js';
import { createStore } from '../src/store.js';
import { createLiveService, createMockProvider } from '../src/transit/index.js';
import { fakeSeoulFetch } from './fixtures/seoulFixture.js';

const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const quiet = { warn() {}, info() {}, error() {} };

function setup({ provider, pushWhenMock = 'label' }) {
  const store = createStore(null);
  store.update('demo', (u) => { u.classes = [CLASS]; u.stop = { arsId: '08901', name: '정릉시장' }; });
  const pushes = [];
  const pusher = { enabled: true, send: async (_s, p) => { pushes.push(p); return []; } };
  let t = new Date('2026-11-08T23:10:00Z');
  const s = createScheduler({ store, provider, pusher, now: () => t, pushWhenMock, log: quiet });
  // 서울 월요일 hh:mm
  const at = async (hhmm) => { const [h, m] = hhmm.split(':').map(Number); t = new Date(Date.UTC(2026, 10, 8, h + 15, m)); return s.tick(); };
  return { at, pushes, s, store };
}

test('예시 데이터(키 없음 데모): 출발 10분 전 한 번, 본문에 출처 표시, 중복 없음, 수업 시작 뒤 없음', async () => {
  const { at, pushes } = setup({ provider: createMockProvider('jeongneung') });
  assert.deepEqual(await at('08:10'), []);
  const sent = await at('08:25');
  assert.deepEqual(sent.map((x) => [x.types, x.source]), [[['depart'], 'mock']]);
  assert.equal(pushes[0].title, '10분 뒤 출발하세요 (08:35)');
  assert.equal(pushes[0].body, `1112번 08:40 탑승 · 강의실 08:55 도착 예정(여유)${MOCK_NOTE}`);
  assert.deepEqual(await at('08:26'), []);
  assert.deepEqual(await at('09:05'), []);
  assert.equal(pushes.length, 1);
});

test('서울시 실시간: 출발 알림 한 번, 출처 seoul(본문에 예시 표시 없음), 시간대 밖에서는 서울시 호출 없음', async () => {
  const fetchImpl = fakeSeoulFetch();
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl, background: false, log: quiet });
  const { at, pushes } = setup({ provider });
  await at('05:30'); // 09:00 수업의 3시간 전보다 이름
  assert.equal(fetchImpl.calls.length, 0);
  const types = [];
  for (const hhmm of ['08:10', '08:15', '08:20', '08:21', '08:22']) types.push(...(await at(hhmm)).flatMap((x) => x.types));
  assert.equal(types.filter((x) => x === 'depart').length, 1);
  const p = pushes.find((x) => /출발하세요/.test(x.title));
  assert.equal(p.source, 'seoul');
  assert.match(p.body, /^\d+번 \d\d:\d\d 탑승 · 강의실 \d\d:\d\d 도착 예정\((여유|빠듯|지각 위험)\)$/);
  provider.stop();
});

test('PUSH_WHEN_MOCK=skip이면 예시 데이터 알림을 보내지 않음', async () => {
  const { at, pushes, s } = setup({ provider: createMockProvider('jeongneung'), pushWhenMock: 'skip' });
  assert.deepEqual(await at('08:25'), []);
  assert.equal(pushes.length, 0);
  assert.ok(s.status().skippedMock > 0);
});

test('예시 데이터로 보낸 출발 알림 뒤 서울시 실시간이 돌아오면 실제 값으로 다시 판단', async () => {
  let down = true;
  const fetchImpl = fakeSeoulFetch({ fail: () => (down ? { ok: false, status: 503, text: async () => 'busy' } : null) });
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl, background: false, log: quiet });
  const { at, pushes } = setup({ provider });
  const first = await at('08:25');
  assert.deepEqual(first.map((x) => x.source), ['mock']);
  assert.ok(pushes[0].body.endsWith(MOCK_NOTE));
  down = false;
  const second = await at('08:26');
  assert.deepEqual(second.map((x) => [x.types, x.source]), [[['depart'], 'seoul']]);
  assert.ok(!pushes[1].body.includes(MOCK_NOTE));
  provider.stop();
});
