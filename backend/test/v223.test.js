// v2.2.3 위치 저장 정밀도 점검: GPS 출발지는 약 100m 칸(소수 셋째 자리)으로 저장 · ODsay에 묻는 순간에만 정확한 좌표 ·
//   예전에 정밀하게 저장된 사용자 기록 · ODsay 검색 결과도 같은 칸으로 옮김(다른 값 · 보관 기한 · 마지막 사용 시각은 그대로).
//   메모리 저장소 · 가짜 ODsay · 가짜 Upstash만 씁니다(실제 서버 호출 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createUpstash, upstashUsers } from '../src/upstash.js';
import { createKv } from '../src/transit/kv.js';
import { createOdsayService } from '../src/transit/odsay.js';
import { coarseUserCoords, createCoordMigration, userCoordStats } from '../src/coords.js';
import { UPSTASH_URL, fakeUpstashFetch } from './fixtures/upstashFixture.js';
import { ODSAY_TEST_KEY, fakeOdsayFetch } from './fixtures/odsayFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult } from '../../shared/transitPlan.js';

const quiet = { warn() {}, info() {}, error() {} };
const DAY = 86400_000;
const IDX = 'kubusai:odsay:idx', RES = (k) => `kubusai:odsay:r:${k}`;
const ROUTE = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0];
const PATHS = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths;
const HOME = { lat: 37.556712, lon: 126.921934 };            // 예시 GPS 위치(홍대입구역 근처 골목 — 정류장 좌표가 아님)
const HOME_CELL = 'g:37.557,126.922';
const STATION = { lat: 37.557527, lon: 126.923778 };         // 홍대입구역(공개 정류장 좌표 — 경로 안에도 들어 있음)
const provider = { name: 'mock', stopTrips: async () => ({ trips: [], source: 'mock' }), stopArrivals: async () => ({ arrivals: [] }), health: () => ({ provider: 'mock' }) };

/** v2.2.2까지의 모양으로 저장된 GPS 검색 결과 하나(키 소수 넷째 자리 · 좌표 소수 여섯째 자리) */
async function putOld(kv, { key, lat, lon, exp, fresh, at, paths = PATHS }) {
  const origin = { name: 'GPS로 고른 위치', lat, lon, kind: 'gps', arsId: '' };
  await kv.set(RES(key), JSON.stringify({ origin, paths, reason: null, at }));
  await kv.hset(IDX, key, JSON.stringify({ lat, lon, name: origin.name, exp, ...(fresh ? { fresh } : {}) }));
}
/** 저장된 출발지 좌표만(경로 안의 정류장 좌표는 공개 값이라 빼고): 목록(IDX) 값 + 결과(RES)의 origin */
const originText = async (kv, keys) => JSON.stringify(await kv.hgetall(IDX)) + (await Promise.all(keys.map(async (k) => JSON.stringify(JSON.parse((await kv.get(RES(k))) || '{}').origin || null)))).join('');

test('새 GPS 검색: ODsay에는 그 순간 정확한 좌표로 묻고, 저장 · 응답은 약 100m 칸(키도 칸) — 역 · 정류장 이름 검색은 그대로', async () => {
  const kv = createKv(), f = fakeOdsayFetch();
  const svc = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv, fetchImpl: f, log: quiet });
  const r = await svc.search({ ...HOME, kind: 'gps' });
  assert.deepEqual([f.calls[0].url.searchParams.get('SX'), f.calls[0].url.searchParams.get('SY')], ['126.921934', '37.556712'], 'ODsay 요청은 정확한 좌표(저장하지 않음)');
  assert.deepEqual([r.ok, r.searchId, r.origin.lat, r.origin.lon, r.origin.kind], [true, HOME_CELL, 37.557, 126.922, 'gps']);
  const saved = JSON.parse(await kv.get(RES(HOME_CELL)));
  assert.deepEqual([saved.origin.lat, saved.origin.lon, saved.paths.length], [37.557, 126.922, 3]);
  const txt = await originText(kv, [HOME_CELL]);
  assert.ok(!txt.includes('37.556712') && !txt.includes('126.921934'), '외부 DB에 정확한 좌표가 남지 않음');
  assert.ok(!JSON.stringify(saved.paths).includes('37.556712'), '경로에는 정류장 좌표 · 걷는 거리만(출발지 좌표 없음)');
  // 같은 칸 근처(약 40m)에서 다시: 저장한 결과 · 칸 좌표
  const again = await svc.search({ lat: 37.5569, lon: 126.9223, kind: 'gps' });
  assert.deepEqual([again.cached, again.searchId, again.origin.lat, f.calls.length], [true, HOME_CELL, 37.557, 1]);
  // 이름으로 고른 역은 공개 좌표 그대로
  const kv2 = createKv(), svc2 = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv: kv2, fetchImpl: fakeOdsayFetch(), log: quiet });
  const st = await svc2.search({ name: '홍대입구역', ...STATION, kind: 'stop', arsId: '14001' });
  assert.deepEqual([st.origin.lat, st.origin.lon, st.origin.kind, st.searchId], [37.557527, 126.923778, 'stop', 'n:홍대입구:37.558,126.924']);
});

test('예전 GPS 검색 결과(정밀) 옮기기: 같은 칸 키로 · 경로 · 검색 시각 · 보관 기한 그대로 · 같은 칸의 더 오래된 것은 지움 · 역 항목 · 끝난 항목은 그대로 · 다시 돌려도 같음', async () => {
  let t = Date.now();
  const kv = createKv({ clock: () => t });
  const svc = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv, fetchImpl: fakeOdsayFetch(), clock: () => t, log: quiet });
  const at = new Date(t - 5 * DAY).toISOString();
  await putOld(kv, { key: 'g:37.5567,126.9219', ...HOME, exp: t + 80 * DAY, fresh: t + 20 * DAY, at });                                 // A
  await putOld(kv, { key: 'g:37.5569,126.9221', lat: 37.556901, lon: 126.922103, exp: t + 70 * DAY, fresh: t + 10 * DAY, at, paths: PATHS.slice(0, 1) }); // B: 같은 칸 · 더 오래됨
  await putOld(kv, { key: 'g:37.6012,127.0123', lat: 37.601234, lon: 127.012345, exp: t + 5 * DAY, at });                              // C: v2.0 항목(fresh 없음)
  await kv.set(RES('n:홍대입구:37.558,126.924'), JSON.stringify({ origin: { name: '홍대입구역', ...STATION, kind: 'stop', arsId: '14001' }, paths: PATHS, reason: null, at }));
  await kv.hset(IDX, 'n:홍대입구:37.558,126.924', JSON.stringify({ ...STATION, name: '홍대입구역', exp: t + 60 * DAY, fresh: t + 25 * DAY })); // D: 역(그대로)
  await putOld(kv, { key: 'g:37.5000,127.0000', lat: 37.500012, lon: 127.000034, exp: t - 1000, fresh: t - 2000, at });                // E: 보관 끝
  await kv.hset(IDX, 'g:37.4900,127.0000', JSON.stringify({ lat: 37.490012, lon: 127.000034, name: 'GPS로 고른 위치', exp: t + DAY, fresh: t + DAY })); // F: 결과 없음
  const r = await svc.coarsenGps();
  assert.deepEqual(r, { gps: 5, moved: 2, merged: 1, skipped: 2 });
  const idx = Object.fromEntries(Object.entries(await kv.hgetall(IDX)).map(([k, v]) => [k, JSON.parse(v)]));
  assert.deepEqual(Object.keys(idx).sort(), ['g:37.5000,127.0000', HOME_CELL, 'g:37.601,127.012', 'n:홍대입구:37.558,126.924'].sort());
  assert.deepEqual(idx[HOME_CELL], { lat: 37.557, lon: 126.922, name: 'GPS로 고른 위치', exp: t + 80 * DAY, fresh: t + 20 * DAY }, '같은 칸에서는 더 새로운 A의 기한');
  assert.deepEqual(idx['g:37.601,127.012'], { lat: 37.601, lon: 127.012, name: 'GPS로 고른 위치', exp: t + 5 * DAY }, 'v2.0 항목은 fresh 없이(예전 규칙 그대로)');
  assert.equal(idx['n:홍대입구:37.558,126.924'].lat, 37.557527, '역 항목은 그대로');
  const a = JSON.parse(await kv.get(RES(HOME_CELL)));
  assert.deepEqual([a.origin, a.paths.length, a.at], [{ name: 'GPS로 고른 위치', lat: 37.557, lon: 126.922, kind: 'gps', arsId: '' }, 3, at], '경로 · 검색 시각 그대로');
  const gText = JSON.stringify(Object.entries(idx).filter(([k]) => k.startsWith('g:') && k !== 'g:37.5000,127.0000')) + (await originText(kv, [HOME_CELL, 'g:37.601,127.012']));
  assert.ok(!/37\.556712|126\.921934|37\.556901|37\.601234/.test(gText), '옮긴 GPS 항목에 정확한 좌표가 없음');
  // 예전 검색 번호는 10분만 더(열려 있던 화면이 그 번호로 저장할 수 있게)
  assert.equal((await svc.byId('g:37.5567,126.9219')).origin.lat, 37.556712);
  t += 601_000;
  assert.deepEqual([await svc.byId('g:37.5567,126.9219'), await svc.byId('g:37.5569,126.9221')], [null, null]);
  // 보관 기한 그대로: A는 80일째까지, C는 5일째까지
  t += 5 * DAY - 601_000 - 1000;
  assert.ok(await svc.byId('g:37.601,127.012'));
  t += 2000;
  assert.equal(await svc.byId('g:37.601,127.012'), null);
  assert.ok(await svc.byId(HOME_CELL));
  // 옮긴 결과로 바로 찾음(호출 없음) · 다시 돌려도 바뀌는 것 없음
  const hit = await svc.search({ lat: 37.5568, lon: 126.9220, kind: 'gps' });
  assert.deepEqual([hit.cached, hit.searchId, hit.origin.lat], [true, HOME_CELL, 37.557]);
  const again = await svc.coarsenGps();
  assert.deepEqual([again.moved, again.merged], [0, 0]);
});

test('사용자 기록: 저장할 때 칸으로(경로를 고를 때 · 근처 정류장으로 직행 안내를 정할 때) — 예전 정밀 검색 결과를 골라도 · 역 · 정류장은 그대로', async () => {
  const kv = createKv(), f = fakeOdsayFetch();
  const odsay = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv, fetchImpl: f, log: quiet });
  await putOld(kv, { key: 'g:37.5567,126.9219', ...HOME, exp: Date.now() + 80 * DAY, fresh: Date.now() + 20 * DAY, at: new Date().toISOString() });
  const store = createStore(null);
  const app = createApp({ store, provider, pusher: { enabled: false, publicKey: null }, odsay });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body) => (await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': 'u223' }, body: body && JSON.stringify(body) })).json();
  try {
    // 화면이 GPS로 찾음(정확한 좌표) → 응답 · 검색 번호는 칸 / 예전 정밀 결과가 300m 안에 있으면 그것을 쓰되 좌표는 칸으로
    const s = await req('POST', '/api/transit/search', { lat: 37.5568, lon: 126.9220, kind: 'gps' });
    assert.deepEqual([s.ok, s.cached, s.searchId, s.origin.lat, s.origin.lon, f.calls.length], [true, true, 'g:37.5567,126.9219', 37.557, 126.922, 0]);
    const saved = await req('POST', '/api/me/transit', { searchId: s.searchId, pathId: ROUTE.id });
    assert.deepEqual([saved.transit.origin.lat, saved.transit.origin.lon, saved.transit.origin.kind], [37.557, 126.922, 'gps']);
    assert.deepEqual([store.user('u223').transit.origin.lat, store.user('u223').transit.route.id], [37.557, ROUTE.id]);
    // 근처 국민대행 정류장으로 직행 안내: 다시 찾을 출발지(GPS)도 칸으로
    const fb = await req('POST', '/api/me/transit', { fallbackStop: { arsId: '08901', name: '정릉시장', walkMin: 5 }, origin: { name: 'GPS로 고른 위치', lat: 37.601234, lon: 127.012345, kind: 'gps' }, reason: 'cap' });
    assert.deepEqual([fb.transit.retry.origin.lat, fb.transit.retry.origin.lon, fb.transit.retry.origin.kind], [37.601, 127.012, 'gps']);
    let h = (await req('GET', '/api/health')).location;
    assert.deepEqual(h, { digits: 3, users: { gps: 2, precise: 0 }, migration: null });
    const st = await req('POST', '/api/me/transit', { fallbackStop: { arsId: '08901', name: '정릉시장', walkMin: 5 }, origin: { name: '정릉시장', lat: 37.601234, lon: 127.012345, kind: 'stop', arsId: '08901' }, reason: 'cap' });
    assert.deepEqual([st.transit.retry.origin.lat, st.transit.retry.origin.kind], [37.601234, 'stop'], '이름으로 고른 정류장은 그대로');
    h = (await req('GET', '/api/health')).location;
    assert.deepEqual(h.users, { gps: 1, precise: 0 });
    assert.ok(!JSON.stringify(h).includes('37.557'), 'health에는 좌표 값을 싣지 않음');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('예전 사용자 기록 옮기기: GPS 출발지 · 다시 찾을 출발지만 칸으로 — 다른 값 · 마지막으로 바뀐 시각 · 역/정류장은 그대로 · 외부 DB에 저장 · 다시 돌려도 같음', async () => {
  const data = {};
  const remote = upstashUsers(createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) }));
  const store = createStore(null, { remote, log: quiet });
  await store.ready;
  const gpsOrigin = { name: 'GPS로 고른 위치', ...HOME, kind: 'gps', arsId: '' };
  store.update('u1', (u) => {
    u.classes = [{ id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' }];
    u.stop = { arsId: '08901', name: '정릉시장' };
    u.transit = { mode: 'transit', origin: gpsOrigin, route: ROUTE, savedAt: '2026-11-20T00:00:00.000Z', retry: { origin: { name: 'GPS로 고른 위치', lat: 37.601234, lon: 127.012345, kind: 'gps', arsId: '' }, reason: 'cap', at: '2026-11-19T00:00:00.000Z' } };
    u.arrivals = [{ key: '2026-11-20:c1', at: '2026-11-20T00:00:00.000Z' }];
  });
  store.update('u2', (u) => { u.transit = { mode: 'transit', origin: { name: '서교동주민센터', lat: 37.551234, lon: 126.925678, kind: 'stop', arsId: '14123' }, route: ROUTE, savedAt: '2026-11-20T00:00:00.000Z', retry: null }; });
  store.update('u3', (u) => { u.transit = { mode: 'transit', origin: { ...gpsOrigin, lat: 37.557, lon: 126.922 }, route: ROUTE, savedAt: '2026-11-21T00:00:00.000Z', retry: null }; });
  store.update('u4', (u) => { u.classes = []; });
  await store.flush();
  const before = JSON.parse(JSON.stringify(Object.fromEntries(store.users())));
  assert.deepEqual(userCoordStats(store), { gps: 3, precise: 2 });

  const job = createCoordMigration({ store, log: quiet });
  assert.deepEqual(await job.run(), { users: 1, origins: 2, odsayCache: null });
  const u1 = store.user('u1');
  assert.deepEqual([u1.transit.origin.lat, u1.transit.origin.lon, u1.transit.retry.origin.lat, u1.transit.retry.origin.lon], [37.557, 126.922, 37.601, 127.012]);
  const expect = JSON.parse(JSON.stringify(before.u1));
  expect.transit.origin = { ...expect.transit.origin, lat: 37.557, lon: 126.922 };
  expect.transit.retry.origin = { ...expect.transit.retry.origin, lat: 37.601, lon: 127.012 };
  assert.deepEqual(JSON.parse(JSON.stringify(u1)), expect, '좌표 말고는 그대로(마지막으로 바뀐 시각 updatedAt도)');
  for (const id of ['u2', 'u3', 'u4']) assert.deepEqual(JSON.parse(JSON.stringify(store.user(id))), before[id], `${id}는 그대로`);
  await store.flush();
  const saved = data['kubusai:users'].u1, so = JSON.parse(saved).transit;
  assert.deepEqual([so.origin.lat, so.origin.lon, so.retry.origin.lat, so.retry.origin.lon], [37.557, 126.922, 37.601, 127.012], '외부 DB에도 칸 좌표');
  assert.ok(!saved.includes('37.556712') && !saved.includes('126.921934') && !saved.includes('37.601234'), '정확한 좌표는 외부 DB에 남지 않음');
  assert.ok(data['kubusai:users'].u2.includes('37.551234'), '이름으로 고른 정류장 출발지는 그대로');
  assert.deepEqual(userCoordStats(store), { gps: 3, precise: 0 });
  assert.equal(coarseUserCoords(store.user('u1')), 0, '이미 칸이면 바꾸지 않음');
  assert.deepEqual((await job.run()).users, 0, '다시 돌려도 바뀌는 것 없음');
  assert.deepEqual(job.health().users, { users: 1, origins: 2 });
  assert.equal(job.health().done, true);
  store.stop();
});

test('외부 DB를 아직 못 읽었으면 옮기지 않고 기다림 · ODsay 검색 결과도 함께 · health에 결과(좌표 값 없음)', async () => {
  const down = createStore(null, { remote: { kind: 'upstash', loadAll: async () => { throw new Error('down'); }, saveMany: async () => {} }, log: quiet, readyWaitMs: 10, loadRetryMs: 60_000 });
  await down.ready;
  const waiting = createCoordMigration({ store: down, log: quiet });
  assert.deepEqual(await waiting.run(), { waiting: true });
  assert.equal(waiting.health().done, false);
  down.stop();

  const kv = createKv(), odsay = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv, fetchImpl: fakeOdsayFetch(), log: quiet });
  await putOld(kv, { key: 'g:37.5567,126.9219', ...HOME, exp: Date.now() + 10 * DAY, fresh: Date.now() + 5 * DAY, at: new Date().toISOString() });
  const store = createStore(null);
  store.update('a', (u) => { u.transit = { mode: 'transit', origin: { name: 'GPS로 고른 위치', ...HOME, kind: 'gps', arsId: '' }, route: ROUTE, savedAt: null, retry: null }; });
  const coords = createCoordMigration({ store, odsay, log: quiet, retryMs: 10 });
  coords.start();
  for (let i = 0; i < 50 && !coords.health().done; i++) await new Promise((r) => setTimeout(r, 10));
  coords.stop();
  assert.deepEqual([coords.health().done, coords.health().users, coords.health().odsayCache], [true, { users: 1, origins: 1 }, { gps: 1, moved: 1, merged: 0, skipped: 0 }]);
  const app = createApp({ store, provider, pusher: { enabled: false, publicKey: null }, odsay, coords });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  try {
    const h = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/health`)).json();
    assert.deepEqual([h.location.digits, h.location.users, h.location.migration.done, h.location.migration.odsayCache.moved], [3, { gps: 1, precise: 0 }, true, 1]);
    assert.ok(!/37\.55|126\.92/.test(JSON.stringify(h.location)), '좌표 값은 싣지 않음');
  } finally { await new Promise((r) => srv.close(r)); }
});
