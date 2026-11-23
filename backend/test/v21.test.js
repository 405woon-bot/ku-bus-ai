// v2.1 서버 점검: 예전 경로(30~90일, 한도 초과 · 오류 · 키 없음일 때만) · v2.0 저장분 보관 연장 · 밤에 주요 환승역 미리 찾기 ·
// 근처 국민대행 정류장(검색 실패 → 직행 안내 저장 · 다시 찾을 출발지) · 환승 실시간 재료의 돌발정보 · 날씨 · '왜 늦나요?'
// 가짜 ODsay · 가짜 서울시 · 메모리 저장소만 씁니다(실제 서버 호출 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOdsayService } from '../src/transit/odsay.js';
import { createOdsayWarmer, parseWarmHours, warmListFromEnv } from '../src/transit/odsayWarm.js';
import { createNearKuFinder, walkChip } from '../src/transit/nearKu.js';
import { transitLive } from '../src/transit/transitLive.js';
import { createKv } from '../src/transit/kv.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService, createMockProvider } from '../src/transit/index.js';
import { createScheduler } from '../src/scheduler.js';
import { fakeOdsayFetch, ODSAY_TEST_KEY } from './fixtures/odsayFixture.js';
import { fakeSeoulFetch } from './fixtures/seoulFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult } from '../../shared/transitPlan.js';
import { WARM_ORIGINS } from '../../shared/warmOrigins.js';

const quiet = { warn() {}, info() {}, error() {}, log() {} };
const kst = (s) => new Date(`${s}+09:00`);
const DAY = 86400_000;
const HONGDAE = { lat: 37.557527, lon: 126.923778, name: '홍대입구역', kind: 'stop' };
const JEONGNEUNG = { lat: 37.6060, lon: 127.0101, name: '정릉시장', kind: 'stop' }; // 국민대 정문에서 약 1.3km
const down = () => ({ status: 503, ok: false, text: async () => 'down' });

test('예전 경로: 30일까지는 새 결과 · 30~90일은 오류 · 한도 초과일 때만 날짜와 함께 · 다시 찾으면 새 결과 · 90일 뒤에는 없음', async () => {
  let t = Date.parse('2026-09-01T08:00:00+09:00'), fail = false;
  const clock = () => t, kv = createKv({ clock });
  const f = fakeOdsayFetch({ respond: () => (fail ? down() : null) });
  const svc = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY, ODSAY_DAILY_CAP: '2' }, kv, fetchImpl: f, clock, log: quiet });
  const a = await svc.search(HONGDAE);
  assert.deepEqual([a.ok, a.cached], [true, false]);
  t += 20 * DAY;
  const b = await svc.search(HONGDAE);
  assert.deepEqual([b.ok, b.cached, b.stale, f.calls.length], [true, true, undefined, 1], '20일: 새 결과(호출 없음)');
  t += 21 * DAY; fail = true; // 41일: 새로 찾아야 하는데 ODsay가 응답하지 않음
  const s = await svc.search(HONGDAE);
  assert.deepEqual([s.ok, s.cached, s.stale, s.staleReason, s.ageDays, s.paths.length, s.searchId], [true, true, true, 'error', 41, 3, a.searchId]);
  assert.equal(s.message, 'ODsay에서 새 경로를 받지 못해서, 41일 전에 찾아 둔 경로를 보여 드려요');
  fail = false;
  await svc.search({ lat: 37.5, lon: 127.05, kind: 'gps' }); // 오늘 상한(2)을 다 씀
  const c = await svc.search(HONGDAE);
  assert.deepEqual([c.stale, c.staleReason, c.calls.today, c.calls.cap], [true, 'cap', 2, 2]);
  assert.match(c.message, /^오늘 새 경로 검색 한도\(2회\)를 다 써서, 41일 전에/);
  assert.equal((await svc.byId(c.searchId)).paths.length, 3, '예전 경로도 고르면 저장할 수 있음');
  t += DAY; // 다음 날: 다시 찾으면 새 결과(30일)
  const d = await svc.search(HONGDAE);
  assert.deepEqual([d.ok, d.cached, d.stale], [true, false, undefined]);
  t += 91 * DAY; fail = true; // 보관(90일) 끝 → 예전 값도 없음
  const e = await svc.search(HONGDAE);
  assert.deepEqual([e.ok, e.reason, e.fallback], [false, 'error', 'direct']);
  assert.deepEqual([svc.health().staleServed, svc.health().freshDays, svc.health().keepDays], [2, 30, 90]);
});

test("예전 경로는 '경로 없음'(ODsay의 새 답)일 때는 쓰지 않음 · 키 없음이면 씀", async () => {
  let t = Date.parse('2026-09-01T08:00:00+09:00'), answer = null;
  const clock = () => t, kv = createKv({ clock });
  const svc = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv, fetchImpl: fakeOdsayFetch({ respond: () => answer }), clock, log: quiet });
  const SINCHON = { lat: 37.5552, lon: 126.9368, name: '신촌역', kind: 'stop' };
  await svc.search(HONGDAE); await svc.search(SINCHON);
  t += 40 * DAY; answer = { error: { code: '-99', msg: '검색결과가 없습니다.' } };
  const r = await svc.search(HONGDAE);
  assert.deepEqual([r.ok, r.reason, r.stale], [false, 'no-path', undefined], 'ODsay가 지금 경로가 없다고 하면 예전 경로를 쓰지 않음');
  const noKey = createOdsayService({ env: {}, kv, clock, log: quiet }); // 같은 저장소 · 키 없는 서버
  const k = await noKey.search(SINCHON);
  assert.deepEqual([k.ok, k.stale, k.staleReason, k.ageDays], [true, true, 'no-key', 40]);
  assert.equal(k.message, '지금은 새 경로를 찾을 수 없어서, 40일 전에 찾아 둔 경로를 보여 드려요');
});

test('v2.0에 30일로 저장한 결과도 다시 쓰면 찾은 날부터 90일까지 남김(예전 경로로 쓸 수 있게)', async () => {
  let t = Date.parse('2026-09-01T08:00:00+09:00');
  const clock = () => t, kv = createKv({ clock });
  const key = 'n:홍대입구:37.558,126.924';
  await kv.set(`kubusai:odsay:r:${key}`, JSON.stringify({ origin: { ...HONGDAE, arsId: '' }, paths: parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths, reason: null, at: new Date(t).toISOString() }), 30 * 86400);
  await kv.hset('kubusai:odsay:idx', key, JSON.stringify({ lat: HONGDAE.lat, lon: HONGDAE.lon, name: '홍대입구역', exp: t + 30 * DAY }));
  const f = fakeOdsayFetch({ respond: down });
  const svc = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv, fetchImpl: f, clock, log: quiet });
  t += 10 * DAY;
  const a = await svc.search(HONGDAE);
  assert.deepEqual([a.ok, a.cached, a.stale, f.calls.length], [true, true, undefined, 0]);
  await new Promise((r) => setTimeout(r, 10)); // 보관 기간 늘리기는 뒤에서
  t += 50 * DAY; // 60일: v2.0이었다면 이미 지워졌을 때
  const b = await svc.search(HONGDAE);
  assert.deepEqual([b.ok, b.stale, b.staleReason, b.ageDays], [true, true, 'error', 60]);
  t += 31 * DAY; // 91일
  assert.equal((await svc.search(HONGDAE)).ok, false);
});

test('밤에 미리 찾기: 정해진 시간에만 · 한 번에 한 곳 · 이름이 같은 정류장(없으면 그 이름으로 시작) · 사용자 검색이 바로 맞물림 · 3회는 남김', async () => {
  let t = Date.parse('2026-11-16T21:05:00+09:00');
  const clock = () => t, kv = createKv({ clock });
  const f = fakeOdsayFetch();
  const odsay = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY, ODSAY_DAILY_CAP: '6' }, kv, fetchImpl: f, clock, log: quiet });
  const STOPS = { 홍대입구역: [{ arsId: '13001', name: '홍대입구역', lat: 37.5575, lon: 126.9245 }], 신촌역: [{ arsId: '13002', name: '신촌역(2호선)', lat: 37.5552, lon: 126.9368 }] };
  const provider = { searchStops: async (q) => STOPS[q] || [] };
  const warmer = createOdsayWarmer({ env: { ODSAY_WARM_ORIGINS: '홍대입구역, 신촌역, 없는역' }, odsay, provider, clock, log: quiet });
  assert.deepEqual([warmer.list, warmer.health().hours, warmer.health().reserve, warmer.health().enabled], [['홍대입구역', '신촌역', '없는역'], '21:00-21:40', 3, true]);
  assert.equal(await warmer.step(kst('2026-11-16T20:59:00')), null, '시간 밖이면 아무것도 안 함');
  assert.equal(f.calls.length, 0);
  const r1 = await warmer.step(new Date(t));
  assert.deepEqual([r1.name, r1.result, f.calls.length], ['홍대입구역', 'warmed', 1]);
  const r2 = await warmer.step(new Date(t));
  assert.deepEqual([r2.name, r2.result, f.calls.length], ['신촌역', 'warmed', 2], "같은 이름이 없으면 그 이름으로 시작하는 정류장('신촌역(2호선)')");
  const r3 = await warmer.step(new Date(t));
  assert.deepEqual([r3.skipped, warmer.health().unresolved, f.calls.length, warmer.health().ready, warmer.health().warmedToday], ['done', ['없는역'], 2, 2, 2]);
  const u = await odsay.search({ lat: 37.5579, lon: 126.9239, name: '홍대입구역', kind: 'stop' });
  assert.deepEqual([u.ok, u.cached, f.calls.length], [true, true, 2], '사용자가 같은 이름으로 찾으면 호출 없이 바로');
  t += DAY; // 다음 날 21:05: 오늘 이미 3회를 써서 남은 3회(= 남겨 둘 수) → 쉼
  for (const d of [0.01, 0.02, 0.03]) await odsay.search({ lat: 37.45 + d, lon: 127.0, kind: 'gps' });
  const w2 = createOdsayWarmer({ env: { ODSAY_WARM_ORIGINS: '잠실역' }, odsay, provider: { searchStops: async () => [{ arsId: '24001', name: '잠실역', lat: 37.5133, lon: 127.1001 }] }, clock, log: quiet });
  assert.deepEqual(await w2.step(new Date(t)), { skipped: 'reserve' });
  assert.equal(f.calls.length, 5);
  assert.equal(createOdsayWarmer({ env: { ODSAY_WARM_ORIGINS: 'off' }, odsay, provider, clock }).health().enabled, false);
  assert.equal(createOdsayWarmer({ env: {}, odsay: createOdsayService({ env: {}, kv, clock, log: quiet }), provider, clock }).health().enabled, false, '키 없으면 끔');
  assert.deepEqual([warmListFromEnv({}).length, warmListFromEnv({ ODSAY_WARM_ORIGINS: 'a,a,b' }), WARM_ORIGINS.length], [46, ['a', 'b'], 46]);
  assert.deepEqual([parseWarmHours('06:00-07:30'), parseWarmHours('잘못'), parseWarmHours('22:00-21:00')], [[360, 450], [1260, 1300], [1260, 1300]]);
});

test('스케줄러가 1분마다 미리 찾기를 부름(알림 계산을 기다리게 하지 않음)', async () => {
  const calls = [];
  const warmer = { step: async (d) => { calls.push(d.toISOString()); return null; } };
  const s = createScheduler({ store: createStore(null), provider: createMockProvider('jeongneung'), pusher: { enabled: false }, now: () => kst('2026-11-16T21:10:00'), warmer, log: quiet });
  await s.tick(); await s.tick();
  assert.equal(calls.length, 2);
});

test('근처 국민대행 정류장: 서울시 내 주변 정류장(400m) → 국민대 정문 · 후문을 지나는 노선이 있는 곳만 · 걷는 시간 → 설정 칩 · 같은 자리는 다시 부르지 않음', async () => {
  const seoul = fakeSeoulFetch();
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl: seoul, background: false, log: quiet });
  const finder = createNearKuFinder({ provider });
  const r = await finder.find(JEONGNEUNG.lat, JEONGNEUNG.lon);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stops.map((s) => [s.arsId, s.name, s.distM, s.walkMin, s.walkChip]), [['08901', '정릉시장', 120, 2, 3]], '도착 정보를 못 받은 정류장(08911 · 08902)은 모름 → 뺌');
  assert.ok(['171', '1711'].every((n) => r.stops[0].routes.includes(n)));
  assert.equal(seoul.calls.find((u) => u.pathname.endsWith('/getStationByPos')).searchParams.get('radius'), '400');
  const n = seoul.calls.length;
  await finder.find(JEONGNEUNG.lat + 0.0001, JEONGNEUNG.lon + 0.0001);
  assert.equal(seoul.calls.length, n, '같은 자리(약 100m 칸)는 6시간 기억');
  assert.deepEqual([walkChip(1), walkChip(4), walkChip(6), walkChip(40)], [3, 5, 10, 15]);
  const none = await createNearKuFinder({ provider: createMockProvider('jeongneung') }).find(37.6, 127.0);
  assert.deepEqual([none.ok, none.reason, none.stops], [false, 'no-key', []], '서울시 키가 없으면 지어내지 않음');
  provider.stop?.();
});

test('근처 국민대행 정류장(v2.3): 일시적으로 확인 못 한 정류장 결과는 6시간 기억하지 않음 · 하나도 못 찾으면 "없음"이 아니라 "확인 못 함"', async () => {
  const clock = { ms: Date.parse('2026-11-23T08:00:00+09:00') };
  const calls = [];
  let down = true; // 서울시가 일시적으로 안 될 때
  const provider = {
    nearStops: async () => [{ arsId: '08901', name: '정릉시장', lat: 37.6, lon: 127.0, distM: 120 }, { arsId: '08902', name: '정릉동', lat: 37.6, lon: 127.0, distM: 200 }],
    stopTrips: async (arsId) => { calls.push(arsId); return down ? { source: 'mock', reason: 'timeout', trips: [] } : { source: 'seoul', trips: [{ no: '171' }] }; },
  };
  const finder = createNearKuFinder({ provider, clock: () => clock.ms });
  const bad = await finder.find(37.6, 127.0);
  assert.deepEqual([bad.ok, bad.reason, bad.stops], [false, 'api', []], '모두 확인 못 하면 없다고 하지 않음');
  const n = calls.length;
  await finder.find(37.6, 127.0);
  assert.equal(calls.length, n, '1분 안에는 다시 부르지 않음(연타 방지)');
  // 1분 뒤 서울시가 살아나면 6시간을 기다리지 않고 바로 다시 확인
  clock.ms += 61_000; down = false;
  const good = await finder.find(37.6, 127.0);
  assert.deepEqual([good.ok, good.stops.map((x) => x.arsId)], [true, ['08901', '08902']]);
  assert.ok(calls.length > n);
  // 이번엔 정상 결과 → 6시간 기억
  const m = calls.length;
  clock.ms += 3600_000; await finder.find(37.6, 127.0);
  assert.equal(calls.length, m, '정상 결과는 6시간 기억');
  clock.ms += 6 * 3600_000; await finder.find(37.6, 127.0);
  assert.ok(calls.length > m, '6시간이 지나면 다시 확인');
  // 일부만 확인 못 한 경우: 찾은 것은 보여 주되 오래 기억하지 않음
  const mixed = createNearKuFinder({ provider: { nearStops: provider.nearStops, stopTrips: async (id) => (id === '08901' ? { source: 'seoul', trips: [{ no: '171' }] } : { source: 'mock', reason: 'api', trips: [] }) }, clock: () => clock.ms });
  const p = await mixed.find(37.6, 127.0);
  assert.deepEqual([p.ok, p.stops.map((x) => x.arsId)], [true, ['08901']]);
  assert.equal(mixed.health().partial, 1);
});

async function serve({ cap = '1', withOdsay = true } = {}, fn) {
  const clock = { t: kst('2026-11-16T07:00:00') };
  const nowMs = () => clock.t.getTime();
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet, clock: nowMs });
  const nearKu = createNearKuFinder({ provider, clock: nowMs });
  const odsay = withOdsay ? createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY, ODSAY_DAILY_CAP: cap }, kv: createKv({ clock: nowMs }), fetchImpl: fakeOdsayFetch(), clock: nowMs, log: quiet }) : null;
  const app = createApp({ store: createStore(null), provider, pusher: { enabled: false, publicKey: null }, now: () => clock.t, odsay, nearKu });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': 'u21' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(req, clock); } finally { srv.close(); provider.stop?.(); }
}

test('API: 한도 초과 → 근처 국민대행 정류장(nearby) → 그 정류장으로 직행 안내 저장(걷는 시간 · 다시 찾을 출발지) → 경로를 고르면 지움', async () => {
  await serve({ cap: '1' }, async (req, clock) => {
    await req('POST', '/api/transit/search', { lat: 37.5, lon: 127.05, kind: 'gps' }); // 오늘 한도(1)를 다른 곳에서 씀
    const s = (await req('POST', '/api/transit/search', JEONGNEUNG)).body;
    assert.deepEqual([s.ok, s.reason, s.nearby.ok, s.nearby.stops[0].arsId, s.nearby.stops[0].walkChip], [false, 'cap', true, '08901', 3]);
    assert.ok(!/직행/.test(s.message));
    const near = (await req('POST', '/api/transit/search', { lat: 37.6085, lon: 127.0002, name: '청덕초등학교입구' })).body;
    assert.deepEqual([near.reason, near.nearby], ['near', undefined], '700m 안이면 근처 정류장을 찾지 않음(걸어가는 편이 빠름)');
    assert.equal((await req('POST', '/api/me/transit', { fallbackStop: { arsId: '12-3', name: 'x' } })).status, 400);
    const saved = (await req('POST', '/api/me/transit', { fallbackStop: { arsId: '08901', name: '정릉시장', walkMin: 3 }, origin: JEONGNEUNG, reason: 'cap' })).body;
    assert.deepEqual([saved.transit.mode, saved.transit.retry.origin.name, saved.transit.retry.reason, saved.stop.arsId, saved.prefs.walkToStopMin], ['direct', '정릉시장', 'cap', '08901', 3]);
    const me = (await req('GET', '/api/me')).body;
    assert.deepEqual([me.stop.name, me.transit.retry.origin.lat, me.prefs.walkToStopMin], ['정릉시장', JEONGNEUNG.lat, 3]);
    const plan = (await req('GET', '/api/plan')).body;
    assert.equal(plan.mode, 'direct', '근처 정류장 직행으로 서버 알림도 계산');
    const sw = (await req('POST', '/api/me/transit', { mode: 'direct' })).body;
    assert.deepEqual([sw.transit.mode, sw.transit.retry], ['direct', null], '고급 스위치로 직접 고르면 경로 다시 찾기는 끝');
    clock.t = new Date(clock.t.getTime() + DAY); // 다음 날 다시 찾기 → 경로를 고르면 retry는 지움
    const again = (await req('POST', '/api/transit/search', JEONGNEUNG)).body;
    assert.equal(again.ok, true);
    const chosen = (await req('POST', '/api/me/transit', { searchId: again.searchId, pathId: 'p0' })).body;
    assert.deepEqual([chosen.transit.mode, chosen.transit.retry ?? null], ['transit', null]);
    const live = (await req('GET', '/api/transit/live')).body;
    assert.deepEqual([live.incidents.source, live.weather.source], ['off', 'off'], '서비스가 없으면 꺼짐(화면 요청에는 늘 이 칸이 있음)');
    const h = (await req('GET', '/api/health')).body;
    assert.ok(h.nearKu && h.nearKu.radiusM === 400 && h.odsay.warm === null);
    assert.ok(h.odsay.lastShape.station.includes('x') && h.odsay.lastShape.station.includes('y'), '경유 정류장 필드 이름(값 없음)');
  });
});

test('API: ODsay 키가 없는 서버도 근처 국민대행 정류장은 알려 줌', async () => {
  await serve({ withOdsay: false }, async (req) => {
    const s = (await req('POST', '/api/transit/search', JEONGNEUNG)).body;
    assert.deepEqual([s.ok, s.reason, s.nearby.stops.map((x) => x.arsId)], [false, 'no-key', ['08901']]);
  });
});

test("환승 실시간 재료: 화면 요청에는 경로 주변 돌발정보 · 날씨 · 마지막 국민대행 버스 '왜 늦나요?' — 버스 구간 좌표로 맞춤 · 좌표는 보내지 않음 · 알림 계산에는 없음", async () => {
  // 272(ODsay 경유 좌표) → 4호선 → 171(정릉시장 08901, 서울시 경유 정류장)
  const R = JSON.parse(JSON.stringify(SAMPLE_ODSAY_RESPONSE));
  Object.assign(R.result.path[1].subPath[5], { startName: '정릉시장', startArsID: '08-901', lane: [{ busNo: '171', type: 11, busID: 1 }] });
  const route = parseOdsayResult(R).paths[1];
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet });
  const seen = {};
  const incidents = { forTrips: async (trips) => { seen.trips = trips; return { source: 'seoul', items: [{ id: 'w1', label: '공사', kind: 'work', title: '테스트 공사', where: 'route', routes: ['171'], status: 'active', rank: 3, distM: 50 }] }; } };
  const weather = { forView: async () => ({ source: 'kma', wet: true, pty: 1, ptyText: '비', rn1Mm: 1.5 }) };
  const explainer = { forTrips: async (trips, ctx) => { seen.ctx = ctx; return trips.map((t) => ({ ...t, delayMin: 4, ...(t.no === '171' ? { explain: { source: 'rule', text: '정릉로가 막혀요.' } } : {}) })); } };
  const out = await transitLive({ route, provider, subway: null, nowDate: kst('2026-11-16T07:00:00'), extras: { incidents, weather, explainer } });
  assert.deepEqual([out.incidents.items[0].title, out.weather.wet, out.final.source], ['테스트 공사', true, 'seoul']);
  const t171 = out.final.trips.find((t) => t.no === '171');
  assert.deepEqual([t171.explain.text, t171.delayMin, typeof t171.kmh, t171.congestion != null], ['정릉로가 막혀요.', 4, 'number', true]);
  assert.ok(!JSON.stringify(out).includes('"path"'), '경로 좌표는 서버 안에서만');
  assert.ok(seen.trips.some((t) => t.no === '171' && t.path.length >= 2), '마지막 버스는 서울시 경유 정류장으로');
  assert.ok(seen.trips.some((t) => t.no === '272' && t.path.length >= 2), '그 밖의 버스 구간은 ODsay 경유 정류장 좌표로');
  assert.ok(!seen.trips.some((t) => /호선/.test(t.no)), '지하철 구간은 도로가 아니라 뺌');
  assert.equal(seen.ctx.incidents.items.length, 1);
  const plain = await transitLive({ route, provider, subway: null, nowDate: kst('2026-11-16T07:00:00') });
  assert.deepEqual([plain.incidents, plain.weather, plain.final.trips.some((t) => t.explain)], [undefined, undefined, false], '서버 알림 계산(extras 없음)은 그대로');
  provider.stop?.();
});
