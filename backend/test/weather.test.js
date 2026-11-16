// 기상청 초단기실황: 응답 해석(JSON · XML · 게이트웨이 오류) · 요청 변수 · 자료 없음 → 한 시간 전 · 10분 캐시 · 실패해도 앱은 그대로 · 키 보호 · /api 연동
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService } from '../src/transit/index.js';
import { WeatherApiError, createWeatherService, parseKmaResponse } from '../src/transit/kmaWeather.js';
import { fakeSeoulFetch } from './fixtures/seoulFixture.js';
import { GATEWAY_KEY, GATEWAY_QUOTA, fakeKmaFetch, ncstItems, ncstJson, ncstXml } from './fixtures/kmaFixture.js';

const MON_0812 = new Date('2026-11-08T23:12:00Z'); // 서울 월 08:12
const T0 = MON_0812.getTime();
const MIN = 60_000;
const quiet = { warn() {}, info() {}, error() {} };
const KEY = 'KMA+SECRET/KEY==';

function service({ key = KEY, fetchImpl = fakeKmaFetch(), env = {}, waitMs } = {}) {
  const clock = { t: T0 };
  const svc = createWeatherService({ env: { KMA_API_KEY: key, ...env }, fetchImpl, clock: () => clock.t, ...(waitMs ? { waitMs } : {}) });
  return { svc, clock, fetchImpl, now: () => new Date(clock.t) };
}

test('응답 해석: JSON 배열 · JSON 한 건(객체) · XML · 자료 없음(03) · 한도(22) · 게이트웨이 인증 오류 · 형식 다름', () => {
  const items = ncstItems('20261109', '0800');
  assert.equal(parseKmaResponse(ncstJson(items)).items.length, items.length);
  assert.deepEqual(parseKmaResponse(ncstJson(items[0])).items, [items[0]], 'item이 객체 하나로 와도');
  const x = parseKmaResponse(ncstXml(items));
  assert.deepEqual(x.items.map((i) => [i.category, i.obsrValue]).slice(0, 2), [['PTY', '1'], ['RN1', '1.5']]);
  assert.throws(() => parseKmaResponse(ncstJson([], { code: '03', msg: 'NO_DATA' })), (e) => e instanceof WeatherApiError && e.kind === 'nodata');
  assert.throws(() => parseKmaResponse(ncstJson([], { code: '22', msg: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR' })), (e) => e.kind === 'quota');
  assert.throws(() => parseKmaResponse(ncstJson([], { code: '10', msg: 'INVALID_REQUEST_PARAMETER_ERROR' })), (e) => e.kind === 'api');
  assert.throws(() => parseKmaResponse(GATEWAY_KEY), (e) => e.kind === 'auth');
  assert.throws(() => parseKmaResponse(GATEWAY_QUOTA), (e) => e.kind === 'quota');
  assert.throws(() => parseKmaResponse('{"foo":1}'), (e) => e.kind === 'parse');
  assert.throws(() => parseKmaResponse('Unexpected errors'), (e) => e.kind === 'parse');
  assert.throws(() => parseKmaResponse('<html><body>점검</body></html>'), (e) => e.kind === 'parse');
});

test('요청: 국민대 격자 nx=60 · ny=128, base_date/base_time(10분 전 정시), dataType=JSON, 인증키는 인코딩해 보냄', async () => {
  const { svc, fetchImpl, now } = service();
  const w = await svc.forView(now());
  assert.deepEqual([w.source, w.ptyText, w.rn1Mm, w.t1h, w.wet, w.baseTime, w.grid], ['kma', '비', 1.5, 7.2, true, '0800', { nx: 60, ny: 128 }]);
  assert.equal(w.raw, undefined, '화면용 값에는 원문을 싣지 않음');
  const u = fetchImpl.calls[0];
  assert.match(u.pathname, /\/1360000\/VilageFcstInfoService_2\.0\/getUltraSrtNcst$/);
  assert.deepEqual(['pageNo', 'numOfRows', 'dataType', 'base_date', 'base_time', 'nx', 'ny'].map((k) => u.searchParams.get(k)), ['1', '20', 'JSON', '20261109', '0800', '60', '128']);
  assert.equal(u.searchParams.get('serviceKey'), KEY, '+ / = 가 들어간 Decoding 키도 그대로 전달');
  assert.match(u.href, /serviceKey=KMA%2BSECRET%2FKEY%3D%3D/);
  // Encoding 키(%가 이미 들어 있음)는 두 번 인코딩하지 않음
  const enc = service({ key: 'KMA%2BSECRET%2FKEY%3D%3D' });
  await enc.svc.forView(enc.now());
  assert.equal(enc.fetchImpl.calls[0].searchParams.get('serviceKey'), KEY);
  // 격자는 환경변수로 바꿀 수 있음
  const moved = service({ env: { KMA_NX: '61', KMA_NY: '127' } });
  await moved.svc.forView(moved.now());
  assert.deepEqual([moved.fetchImpl.calls[0].searchParams.get('nx'), moved.fetchImpl.calls[0].searchParams.get('ny')], ['61', '127']);
});

test('정시 자료가 아직 없으면(NODATA) 한 시간 전 자료', async () => {
  const fetchImpl = fakeKmaFetch({ noData: (t) => t === '0800' });
  const { svc, now } = service({ fetchImpl });
  const w = await svc.forView(now());
  assert.deepEqual([w.source, w.baseTime], ['kma', '0700']);
  assert.deepEqual(fetchImpl.calls.map((u) => u.searchParams.get('base_time')), ['0800', '0700']);
});

test('캐시: 10분 동안은 다시 부르지 않음(WEATHER_CACHE_SEC 600~1800), 동시에 불러도 한 번만', async () => {
  const { svc, clock, fetchImpl, now } = service();
  await svc.forView(now());
  clock.t += 9 * MIN; await svc.forView(now()); await svc.inspect(now());
  assert.equal(fetchImpl.calls.length, 1);
  clock.t += 1 * MIN + 1; await svc.forView(now());
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(service({ env: { WEATHER_CACHE_SEC: '60' } }).svc.health().cacheSec, 600);
  assert.equal(service({ env: { WEATHER_CACHE_SEC: '3600' } }).svc.health().cacheSec, 1800);
  assert.equal(service({ env: { WEATHER_CACHE_SEC: '900' } }).svc.health().cacheSec, 900);
  const s2 = service();
  await Promise.all([s2.svc.forView(s2.now()), s2.svc.forView(s2.now()), s2.svc.forView(s2.now())]);
  assert.equal(s2.fetchImpl.calls.length, 1);
  // 하루 내내 화면이 열려 있어도 호출 수는 한도(10,000)보다 훨씬 적음
  const day = service();
  for (let m = 0; m < 24 * 60; m += 1) { day.clock.t = T0 + m * MIN; await day.svc.forView(day.now()); }
  assert.ok(day.fetchImpl.calls.length <= 150, `${day.fetchImpl.calls.length}회`);
});

test('실패해도 앱은 그대로: 90분 이내 직전 값 → 그보다 오래되면 error(날씨만 빠짐), 실패 뒤 5분 · 한도 초과 뒤 1시간은 다시 안 부름', async () => {
  let mode = 'ok';
  const fetchImpl = fakeKmaFetch({ fail: () => (mode === 'down' ? { ok: false, status: 500, text: async () => 'Unexpected errors' } : mode === 'quota' ? { ok: true, status: 200, text: async () => GATEWAY_QUOTA } : null) });
  const { svc, clock, now } = service({ fetchImpl });
  await svc.forView(now());
  mode = 'down'; clock.t += 11 * MIN;
  let w = await svc.forView(now());
  assert.deepEqual([w.source, w.stale, w.ptyText], ['kma', true, '비']);
  const n = fetchImpl.calls.length;
  clock.t += 3 * MIN; await svc.forView(now());
  assert.equal(fetchImpl.calls.length, n, '5분 안에는 다시 부르지 않음');
  assert.equal(svc.health().lastError.kind, 'http');
  clock.t += 90 * MIN;
  w = await svc.forView(now());
  assert.deepEqual([w.source, w.reason], ['error', 'http']);
  mode = 'quota'; clock.t += 6 * MIN;
  w = await svc.forView(now());
  assert.deepEqual([w.source, w.reason], ['error', 'quota']);
  const q = fetchImpl.calls.length;
  mode = 'ok'; clock.t += 30 * MIN; await svc.forView(now());
  assert.equal(fetchImpl.calls.length, q, '한도 초과 뒤 1시간은 쉼');
  clock.t += 31 * MIN;
  w = await svc.forView(now());
  assert.deepEqual([w.source, w.stale], ['kma', false]);
  assert.equal(svc.health().lastError, null);
});

test('형식이 예상과 다르면(PTY · RN1 없음) 날씨만 빠지고 이유가 남음', async () => {
  const fetchImpl = fakeKmaFetch({ fail: () => ({ ok: true, status: 200, text: async () => ncstJson([{ baseDate: '20261109', baseTime: '0800', category: 'T1H', obsrValue: '7' }]) }) });
  const { svc, now } = service({ fetchImpl });
  const w = await svc.forView(now());
  assert.deepEqual([w.source, w.reason], ['error', 'format']);
  assert.match(w.message, /확인 필요/);
});

test('키 보호 · 키 없음: 오류 · 상태 어디에도 인증키가 없고, 키가 없으면 꺼짐(off) · 버스도 예시면 예시 날씨(mock)', async () => {
  const fetchImpl = fakeKmaFetch({ fail: (u) => { throw new Error(`getaddrinfo ENOTFOUND ${u.href}`); } });
  const { svc, now } = service({ fetchImpl });
  const w = await svc.forView(now());
  const all = JSON.stringify([w, svc.health(), await svc.inspect(now())]);
  assert.equal(w.source, 'error');
  assert.ok(!all.includes(KEY) && !all.includes(encodeURIComponent(KEY)), all);
  const off = service({ key: '' });
  assert.deepEqual(await off.svc.forView(off.now()), { source: 'off', reason: 'no-key' });
  const ex = await off.svc.forView(off.now(), { example: true });
  assert.deepEqual([ex.source, ex.ptyText, ex.rn1Mm], ['mock', '비', 1.5]);
  assert.equal(off.fetchImpl.calls.length, 0);
  assert.equal(off.svc.health().keyConfigured, false);
});

test('확인용 /api/weather: 격자 · 원문(raw) · 형식 미확인 표시 / trips에 weather / health에 날씨 상태', async () => {
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet });
  const weather = createWeatherService({ env: { KMA_API_KEY: KEY }, fetchImpl: fakeKmaFetch(), clock: () => T0 });
  const app = createApp({ store: createStore(null), provider, pusher: { enabled: false, publicKey: null, send: async () => [] }, now: () => MON_0812, weather });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const get = async (p) => (await fetch(`http://127.0.0.1:${srv.address().port}${p}`)).json();
  try {
    const wx = await get('/api/weather');
    assert.deepEqual([wx.source, wx.grid, wx.ptyText, wx.rn1Mm, wx.formatVerified], ['kma', { nx: 60, ny: 128 }, '비', 1.5, false]);
    assert.deepEqual([wx.raw.PTY, wx.raw.RN1, wx.raw.T1H], ['1', '1.5', '7.2']);
    const trips = await get('/api/stops/08901/trips');
    assert.deepEqual([trips.source, trips.weather.source, trips.weather.wet, trips.weather.raw], ['seoul', 'kma', true, undefined]);
    assert.equal(trips.incidents.source, 'off', '돌발정보 서비스가 없어도 함께 동작');
    const h = await get('/api/health');
    assert.deepEqual([h.weather.keyConfigured, h.weather.grid, h.weather.lastObs, h.weather.wet], [true, { nx: 60, ny: 128 }, '20261109 0800', true]);
    assert.ok(!JSON.stringify([wx, trips, h]).includes('SECRET'));
  } finally { srv.close(); provider.stop?.(); }
});
