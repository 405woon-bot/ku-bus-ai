// 서울시 실시간 돌발정보(AccInfo): 응답 해석 · 5분 캐시 · 직전 값 · 키 보호 · 경로 매칭 · /api 연동
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService } from '../src/transit/index.js';
import { AccidentApiError, createAccidentService, parseAccInfoXml } from '../src/transit/seoulAccident.js';
import { fakeSeoulFetch } from './fixtures/seoulFixture.js';
import { ACC_ROWS, accXml, fakeAccidentFetch } from './fixtures/accidentFixture.js';

const MON_0810 = new Date('2026-11-08T23:10:00Z'); // 서울 월 08:10
const T0 = MON_0810.getTime();
const quiet = { warn() {}, info() {}, error() {} };
const MIN = 60_000;
const TRIPS = [{ no: '171', path: [{ lat: 37.60785, lon: 127.0022, name: '고려대사범대학부속고등학교' }, { lat: 37.6085, lon: 127.00025, name: '청덕초등학교입구' }, { lat: 37.6106, lon: 126.997, name: '국민대학교앞' }] }];

function service({ key = 'ACC-SECRET-KEY', fetchImpl = fakeAccidentFetch(), env = {}, waitMs } = {}) {
  const clock = { t: T0 };
  const svc = createAccidentService({ env: { SEOUL_ACCIDENT_API_KEY: key, ...env }, fetchImpl, clock: () => clock.t, ...(waitMs ? { waitMs } : {}) });
  return { svc, clock, fetchImpl, now: () => new Date(clock.t) };
}

test('응답 해석: 정상 · 데이터 없음(INFO-200) · 인증키 오류 · 서버 오류 · XML 아님', () => {
  const ok = parseAccInfoXml(accXml());
  assert.equal(ok.total, ACC_ROWS.length);
  assert.equal(ok.rows.length, ACC_ROWS.length);
  assert.equal(ok.rows[3].acc_info, '탄천나들목 및 봉은교 구조개선공사-일시 : 26.4.7(화)10:00~27.2.28(일) 23:59-장소 : 봉은교-통제 : 양방향 전면통제');
  assert.equal(ok.rows[3].grs80tm_x, '206076.7132692197');
  assert.deepEqual(parseAccInfoXml(accXml([], { code: 'INFO-200', msg: '해당하는 데이터가 없습니다.' })).rows, []);
  assert.throws(() => parseAccInfoXml(accXml([], { code: 'INFO-100', msg: '인증키가 유효하지 않습니다.' })), (e) => e instanceof AccidentApiError && e.kind === 'auth');
  assert.throws(() => parseAccInfoXml(accXml([], { code: 'ERROR-500', msg: '서버 오류입니다.' })), (e) => e.kind === 'api' && /ERROR-500/.test(e.message));
  assert.throws(() => parseAccInfoXml('<html>점검 중</html>'), (e) => e.kind === 'parse');
});

test('경로 주변만: 경로 위 공사 + 국민대 근처 행사(예정). 다른 종류 · 먼 곳 · 끝난 것 · 다음 주 것은 빠짐', async () => {
  const { svc, fetchImpl } = service();
  const r = await svc.forTrips(TRIPS, MON_0810);
  assert.equal(r.source, 'seoul');
  assert.deepEqual(r.items.map((x) => [x.id, x.type, x.where, x.status]), [['T-WORK', 'A04', 'route', 'active'], ['T-EVENT', 'A10', 'campus', 'soon']]);
  assert.equal(r.items[0].title, '정릉로 하수관 정비공사(테스트)');
  assert.equal(r.items[0].nearStop, '청덕초등학교입구');
  assert.deepEqual(r.items[0].routes, ['171']);
  assert.equal(r.stale, false);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].pathname, /\/xml\/AccInfo\/1\/1000\/$/);
});

test('캐시: 5분 동안은 다시 부르지 않고, 5분이 지나면 한 번 다시 받음(ACCIDENT_CACHE_SEC로 바꿀 수 있음, 최소 60초)', async () => {
  const { svc, clock, fetchImpl, now } = service();
  await svc.forTrips(TRIPS, now());
  clock.t += 4 * MIN; await svc.forTrips(TRIPS, now()); await svc.forTrips([], now());
  assert.equal(fetchImpl.calls.length, 1);
  clock.t += 1 * MIN + 1; await svc.forTrips(TRIPS, now());
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(service({ env: { ACCIDENT_CACHE_SEC: '10' } }).svc.health().cacheSec, 60);
  assert.equal(service({ env: { ACCIDENT_CACHE_SEC: '180' } }).svc.health().cacheSec, 180);
  // 동시에 여러 화면이 불러도 서울시에는 한 번만
  const s2 = service();
  await Promise.all([s2.svc.forTrips(TRIPS, s2.now()), s2.svc.forTrips(TRIPS, s2.now()), s2.svc.forTrips(TRIPS, s2.now())]);
  assert.equal(s2.fetchImpl.calls.length, 1);
});

test('실패: 15분 이내면 직전 값(stale), 실패 뒤 1분은 다시 부르지 않음, 15분이 넘으면 빈 목록 + 이유', async () => {
  let down = false;
  const fetchImpl = fakeAccidentFetch({ fail: () => (down ? { ok: false, status: 503, text: async () => 'busy' } : null) });
  const { svc, clock, now } = service({ fetchImpl });
  await svc.forTrips(TRIPS, now());
  down = true;
  clock.t += 6 * MIN;
  let r = await svc.forTrips(TRIPS, now());
  assert.deepEqual([r.source, r.stale, r.ageSec, r.items.length], ['seoul', true, 360, 2]);
  assert.equal(fetchImpl.calls.length, 2);
  clock.t += 30_000; await svc.forTrips(TRIPS, now());
  assert.equal(fetchImpl.calls.length, 2, '실패 뒤 1분 안에는 다시 부르지 않음');
  assert.equal(svc.health().lastError.kind, 'http');
  clock.t += 10 * MIN;
  r = await svc.forTrips(TRIPS, now());
  assert.deepEqual([r.source, r.reason, r.items], ['error', 'http', []]);
  down = false; clock.t += 2 * MIN;
  r = await svc.forTrips(TRIPS, now());
  assert.deepEqual([r.source, r.stale], ['seoul', false]);
  assert.equal(svc.health().lastError, null);
});

test('키 보호: 오류 메시지 · 상태 어디에도 인증키가 남지 않음, 키가 없으면 꺼짐(off)', async () => {
  const key = 'ACC-SECRET-KEY';
  const fetchImpl = fakeAccidentFetch({ fail: (u) => { throw new Error(`connect ECONNREFUSED ${u.href}`); } });
  const { svc, now } = service({ key, fetchImpl });
  const r = await svc.forTrips(TRIPS, now());
  assert.equal(r.source, 'error');
  assert.ok(!JSON.stringify(r).includes(key) && !JSON.stringify(svc.health()).includes(key), JSON.stringify(r));
  assert.match(r.message, /\[KEY\]/);
  const off = service({ key: '' });
  assert.deepEqual(await off.svc.forTrips(TRIPS, off.now()), { source: 'off', reason: 'no-key', items: [] });
  assert.equal(off.svc.health().keyConfigured, false);
  assert.equal(off.fetchImpl.calls.length, 0);
});

test('1000건이 넘으면 나눠 받음 · 첫 응답이 늦으면 화면은 기다리지 않고(loading) 다음 요청에 반영', async () => {
  const many = fakeAccidentFetch({ fail: (u) => (u.pathname.endsWith('/1/1000/') ? { ok: true, status: 200, text: async () => accXml(ACC_ROWS, { total: 1500 }) } : null) });
  const { svc } = service({ fetchImpl: many });
  await svc.forTrips(TRIPS, MON_0810);
  assert.deepEqual(many.calls.map((u) => u.pathname.split('/AccInfo/')[1]), ['1/1000/', '1001/2000/']);

  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = fakeAccidentFetch({ fail: async () => { await gate; return null; } });
  const s = service({ fetchImpl: slow, waitMs: 30 });
  assert.deepEqual(await s.svc.forTrips(TRIPS, s.now()), { source: 'loading', reason: 'loading', items: [] });
  release(); await new Promise((r) => setTimeout(r, 10));
  const r = await s.svc.forTrips(TRIPS, s.now());
  assert.deepEqual([r.source, r.items.length, slow.calls.length], ['seoul', 2, 1]);
});

test('버스가 예시 데이터면 예시 돌발정보 1건(source mock), 서울시에는 부르지 않음', async () => {
  const { svc, fetchImpl, now } = service();
  const r = await svc.forTrips([{ no: '171' }], now(), { example: true });
  assert.deepEqual([r.source, r.items.length, r.items[0].id, r.items[0].where], ['mock', 1, 'SAMPLE-1', 'campus']);
  assert.match(r.items[0].title, /예시/);
  assert.equal(fetchImpl.calls.length, 0);
});

async function serve({ busKey = 'TESTKEY', accKey = 'ACC-SECRET-KEY', accFetch = fakeAccidentFetch() } = {}, fn) {
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: busKey }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet });
  const incidents = createAccidentService({ env: { SEOUL_ACCIDENT_API_KEY: accKey }, fetchImpl: accFetch, clock: () => T0 });
  const app = createApp({ store: createStore(null), provider, pusher: { enabled: false, publicKey: null, send: async () => [] }, now: () => MON_0810, incidents });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  try { await fn(get); } finally { srv.close(); provider.stop?.(); }
}

test('/api/stops/:arsId/trips에 incidents가 붙고(경로 path 포함 노선과 매칭), /api/health에 돌발정보 상태', async () => {
  await serve({}, async (get) => {
    const j = await get('/api/stops/08901/trips');
    assert.equal(j.source, 'seoul');
    assert.ok(j.trips.every((t) => t.path.length >= 2), '노선마다 경로 좌표');
    assert.equal(j.incidents.source, 'seoul');
    assert.deepEqual(j.incidents.items.map((x) => [x.id, x.where]), [['T-WORK', 'route'], ['T-EVENT', 'campus']]);
    assert.deepEqual(j.incidents.items[0].routes, ['1711', '171', '1112']);
    const h = await get('/api/health');
    assert.deepEqual([h.incidents.keyConfigured, h.incidents.cacheSec, h.incidents.total, h.incidents.shown], [true, 300, ACC_ROWS.length, ACC_ROWS.length - 1]);
    assert.ok(!JSON.stringify(h).includes('ACC-SECRET-KEY'));
  });
  // 버스 키가 없으면(예시 데이터) 돌발정보도 예시 1건
  await serve({ busKey: '' }, async (get) => {
    const j = await get('/api/stops/08901/trips');
    assert.deepEqual([j.source, j.incidents.source, j.incidents.items.length], ['mock', 'mock', 1]);
  });
  // 돌발정보 키만 없으면 꺼짐(예시를 섞지 않음)
  await serve({ accKey: '' }, async (get) => {
    const j = await get('/api/stops/08901/trips');
    assert.deepEqual([j.source, j.incidents.source, j.incidents.items], ['seoul', 'off', []]);
    assert.equal((await get('/api/health')).incidents.keyConfigured, false);
  });
});
