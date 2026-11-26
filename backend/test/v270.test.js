// v2.7.0 환승 버스(서울시 · 경기도 정류장) 실시간 점검:
//   서울시 버스 하루 호출 수(서비스별 · 외부 DB 이어받기 · 자정에 새로) · 서울시 정류장 환승 버스(새로 부를 때만 몫 100 · 60초 다시 쓰기 · 첫 · 마지막 버스 값 다시 쓰기 ·
//   보호선 800 · 한도 초과 쉼) · 경기도 정류장 환승 버스(몫 150 · 60초 · 도착 정보 900 안에서 · 첫 버스 개수와 따로) ·
//   어디에 묻나(v2.5.0 정류장 판단: 쓸 수 있음 → 경기도 / 서울 · 못 찾음 등 → 서울시 / 애매함 · 두 방향 · 실패 · 입력 부족 → 부르지 않음 / 판단 전 → 이번엔 판단만) ·
//   서울시 확인(정류장 번호 · 버스 번호 · 같은 번호 두 줄 · 정류장 이름 · 운행 종료) · 창 · 출발 기록 · 끄기 · 서버 출발 알림에는 없음 · API · health(개수만) · .env.example.
//   가짜 서울시 · 가짜 경기도 API만 씁니다(실제 호출 없음). 경로 · 정류장 · 도착 값은 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEOUL_BUS_MID_DEFAULT_CAP, SEOUL_BUS_MID_GUARD, createLiveService } from '../src/transit/index.js';
import { createMemoryCache } from '../src/transit/cache.js';
import { createKv } from '../src/transit/kv.js';
import { GG_MID_DEFAULT_CAP, createGyeonggiBusService } from '../src/transit/gyeonggiBus.js';
import { transitLive } from '../src/transit/transitLive.js';
import { planFor } from '../src/planner.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { fakeSeoulFetch, xml } from './fixtures/seoulFixture.js';
import { GG_TEST_KEY, fakeGyeonggiFetch } from './fixtures/gyeonggiFixture.js';
import { SAMPLE_ODSAY_MIDBUS } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult, routeKey } from '../../shared/transitPlan.js';
import { arrivalKey } from '../../shared/arrival.js';
import { seoulParts } from '../../shared/time.js';

const quiet = { warn() {}, info() {}, error() {} };
const kst = (s) => new Date(`${s}+09:00`).getTime();
const tick = () => new Promise((r) => setTimeout(r, 10));
const NOW = kst('2026-11-16T08:05:00'); // 월요일
const CLS = { id: 'c1', name: '자료구조', day: 0, start: '09:30', end: '10:45', building: '미래관', room: '301' };
const DEP = 7 * 60 + 40; // 07:40 '출발했어요!' → 2호선 07:48 ~ 08:03 → 150 정류장 08:10 도착 · 08:14 예정 탑승 → 07:59 ~ 08:29
// 예시 경로: 2호선 → 환승 버스 150(가짜 서울시 정류장 08920 시청앞.덕수궁) → 1213
const RESP = JSON.parse(JSON.stringify(SAMPLE_ODSAY_MIDBUS));
Object.assign(RESP.result.path[0].subPath[3], { startArsID: '08-920' });
const ROUTE = parseOdsayResult(RESP).paths[0];
const HINT = { i: 3, at: 490 };
// 같은 경로의 환승 버스를 가짜 경기도 API의 수원역(03128) 7770으로(경기도 정류장 예시)
const GG_RESP = JSON.parse(JSON.stringify(SAMPLE_ODSAY_MIDBUS));
Object.assign(GG_RESP.result.path[0].subPath[3], { startName: '수원역', startX: 127.0003, startY: 37.2659, startArsID: '03-128', lane: [{ busNo: '7770', type: 4, busID: 1 }] });
const GG_ROUTE = parseOdsayResult(GG_RESP).paths[0];
const legWith = (route, o) => ({ ...route, legs: route.legs.map((l, i) => (i === 3 ? { ...l, ...o, from: { ...l.from, ...(o.from || {}) } } : l)) });

function seoul({ env = {}, t = NOW, fail, kv = null } = {}) {
  const clock = { t };
  const f = fakeSeoulFetch({ fail });
  const svc = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TEST-KEY', ...env }, fetchImpl: f, cache: createMemoryCache({ clock: () => clock.t }), clock: () => clock.t, background: false, log: quiet, kv });
  const at = (ars) => f.calls.filter((u) => u.pathname.endsWith('/getStationByUid') && u.searchParams.get('arsId') === ars).length;
  return { svc, f, clock, midCalls: () => at('08920'), at };
}
function gyeonggi({ env = {}, t = NOW, key = GG_TEST_KEY } = {}) {
  const clock = { t };
  const f = fakeGyeonggiFetch();
  const svc = createGyeonggiBusService({ env: { GYEONGGI_BUS_API_KEY: key, ...env }, fetchImpl: f, clock: () => clock.t, log: quiet });
  return { svc, f, clock, arrivalCalls: () => f.calls.filter((c) => c.op === 'getBusArrivalListv2').length };
}
const live = (provider, { t = NOW, midHint = HINT, departedMin = DEP, route = ROUTE, gg = null } = {}) =>
  transitLive({ route, provider, subway: null, gyeonggi: gg, nowDate: new Date(t), cls: CLS, walkTable: {}, departedMin, midHint });
const row = (o) => ({ busRouteId: '900000150', rtNm: '150', busRouteAbrv: '150', stNm: '시청앞.덕수궁', staOrd: '31', arrmsg1: '4분후[2번째 전]', traTime1: '240', term: '6', ...o });
const respond08920 = (items) => (u) => (u.pathname.endsWith('/getStationByUid') && u.searchParams.get('arsId') === '08920' ? { ok: true, status: 200, text: async () => xml(items) } : null);

test('서울시 버스 하루 호출 수(서비스별): 정류소정보조회 · 노선정보조회를 셈 · 외부 DB 값 이어받기 · 자정에 새로', async () => {
  const kv = createKv({ clock: () => NOW });
  for (let k = 0; k < 3; k++) await kv.incr('kubusai:seoulbus:calls:stationinfo:2026-11-16', 60);
  const { svc, clock } = seoul({ kv });
  await tick();
  assert.deepEqual(svc.health().callsToday, { stationinfo: 3, busRouteInfo: 0 }, '서버를 다시 켜도 그날 값 이어감');
  await svc.stopTrips('08901'); // 정류장 도착 1건 + 지나는 노선 4개의 경유 정류소 4건
  await tick();
  assert.deepEqual(svc.health().callsToday, { stationinfo: 4, busRouteInfo: 4 });
  assert.deepEqual([await kv.getNum('kubusai:seoulbus:calls:stationinfo:2026-11-16'), await kv.getNum('kubusai:seoulbus:calls:busRouteInfo:2026-11-16')], [4, 4]);
  clock.t = kst('2026-11-17T00:01:00');
  assert.deepEqual(svc.health().callsToday, { stationinfo: 0, busRouteInfo: 0 }, '자정이 지나면 새로');
  assert.deepEqual([SEOUL_BUS_MID_DEFAULT_CAP, SEOUL_BUS_MID_GUARD, GG_MID_DEFAULT_CAP], [100, 800, 150]);
});

test('서울시 정류장 환승 버스: 새로 부를 때만 몫 · 60초 안에는 다시 씀(흐른 초) · 첫 · 마지막 버스가 30초 안에 받은 값은 몫을 쓰지 않음 · 응답의 정류장 이름', async () => {
  const { svc, f, clock, midCalls } = seoul();
  const a = await svc.stopArrivalsMid('08920');
  assert.deepEqual([a.source, a.ageSec, a.arrivals.map((x) => [x.no, x.etasSec, x.stopName])], ['seoul', 0, [['150', [240, 660], '시청앞.덕수궁'], ['402', [120], '시청앞.덕수궁']]]);
  assert.deepEqual([midCalls(), svc.health().mid.callsToday], [1, 1]);
  clock.t = NOW + 40_000;
  const b = await svc.stopArrivalsMid('08920');
  assert.deepEqual([b.source, b.ageSec, midCalls(), svc.health().mid.callsToday], ['seoul', 40, 1, 1], '40초 뒤: 부르지 않고 받은 지 40초');
  clock.t = NOW + 70_000;
  await svc.stopArrivalsMid('08920');
  assert.deepEqual([midCalls(), svc.health().mid.callsToday], [2, 2], '70초 뒤: 새로');
  // 첫 버스(서울시 정류장)가 막 받은 값 → 환승 버스는 그 값을(부르지 않음 · 몫 그대로)
  clock.t = NOW + 100_000;
  await svc.stopArrivals('08901');
  const n = f.calls.length;
  clock.t = NOW + 110_000;
  const c = await svc.stopArrivalsMid('08901');
  assert.deepEqual([c.source, c.ageSec, f.calls.length, svc.health().mid.callsToday], ['seoul', 10, n, 2]);
  assert.equal(svc.health().mid.reuseSec, 60);
});

test('서울시 보호선: 오늘 정류소정보조회가 800회면 환승 버스만 멈춤(첫 버스는 그대로) · 몫을 다 쓰면 mid-cap · 한도 초과 응답이면 쉬는 동안 부르지 않음', async () => {
  const kv = createKv({ clock: () => NOW });
  for (let k = 0; k < SEOUL_BUS_MID_GUARD; k++) await kv.incr('kubusai:seoulbus:calls:stationinfo:2026-11-16', 60);
  const g = seoul({ kv });
  await tick();
  assert.deepEqual(await g.svc.stopArrivalsMid('08920'), { source: 'cap', reason: 'guard', arrivals: [] });
  assert.equal(g.midCalls(), 0);
  const first = await g.svc.stopArrivals('08901');
  assert.deepEqual([first.source, g.at('08901')], ['seoul', 1], '첫 버스는 그대로 부름');
  const h = g.svc.health().mid;
  assert.deepEqual([h.guardAt, h.guardReached, h.callsToday, h.capReached], [800, true, 0, false]);
  // 몫 1회
  const m = seoul({ env: { SEOUL_BUS_MID_DAILY_CAP: '1' } });
  await m.svc.stopArrivalsMid('08920');
  m.clock.t = NOW + 70_000;
  assert.deepEqual(await m.svc.stopArrivalsMid('08920'), { source: 'cap', reason: 'mid-cap', arrivals: [] });
  assert.deepEqual([m.midCalls(), m.svc.health().mid.capReached], [1, true]);
  // 한도 초과(HTTP 429) → 그 결과도 60초 보관 · 그 뒤에도 쉬는 동안(15분)은 부르지 않음
  const q = seoul({ fail: (u) => (u.pathname.endsWith('/getStationByUid') ? { ok: false, status: 429, text: async () => 'LIMITED' } : null) });
  const r1 = await q.svc.stopArrivalsMid('08920');
  q.clock.t = NOW + 70_000;
  const r2 = await q.svc.stopArrivalsMid('08920');
  assert.deepEqual([r1.source, r1.reason, r2.source, r2.reason, q.midCalls()], ['cap', 'quota', 'cap', 'quota', 1]);
});

test('어디에 묻나: 경기도 키가 없으면 서울시 정류장 도착 — 정류장 번호 + 버스 번호(150만) · 받은 지 흐른 초를 뺌 · 출처 seoul', async () => {
  const { svc, clock, midCalls } = seoul();
  const out = await live(svc);
  assert.deepEqual(out.mid, { i: 3, kind: 'bus', stop: '시청앞.덕수궁', no: '150', region: 'seoul', source: 'seoul', arsId: '08920',
    buses: [{ no: '150', termMin: 6, msgs: ['4분후[2번째 전]', '11분후[5번째 전]'], etasSec: [240, 660] }] });
  assert.equal(midCalls(), 1);
  clock.t = NOW + 30_000;
  const later = await live(svc, { t: clock.t });
  assert.deepEqual([later.mid.buses[0].etasSec, midCalls()], [[210, 630], 1], '30초 뒤: 다시 쓰면서 흐른 초를 뺌');
  const h = svc.health().mid;
  assert.deepEqual([h.used, h.callsToday], [2, 1]);
});

test('어디에 묻나: 경기도 판단 전이면 이번엔 판단만(경기도 정류소 조회만 · 도착 정보 · 서울시는 부르지 않음) → 다음 요청부터 판단대로(서울시 정류장 → 서울시)', async () => {
  const S = seoul(), G = gyeonggi();
  const first = await live(S.svc, { gg: G.svc });
  assert.deepEqual([first.mid.source, first.mid.reason, S.midCalls(), G.arrivalCalls()], ['skip', 'judging', 0, 0]);
  assert.ok(G.f.calls.every((c) => c.service === 'busstationservice'), '판단에는 정류소 조회만');
  assert.equal(G.svc.health().mid.skipped.judging, 1);
  await G.svc.settle();
  const second = await live(S.svc, { gg: G.svc, t: NOW + 30_000 });
  assert.deepEqual([second.mid.region, second.mid.source, S.midCalls(), G.arrivalCalls()], ['seoul', 'seoul', 1, 0], '서울시 정류장(경기도 판단: 못 찾음)');
});

test('어디에 묻나: 경기도 정류장으로 확인되면 경기도 도착 정보(그 노선 · 순번 줄만) · 몫 · 60초 다시 쓰기 · 첫 버스 개수와 따로', async () => {
  const S = seoul(), G = gyeonggi();
  const at = (ms) => { S.clock.t = G.clock.t = ms; return ms; };
  await live(S.svc, { gg: G.svc, route: GG_ROUTE }); // 판단 시작
  await G.svc.settle();
  const out = await live(S.svc, { gg: G.svc, route: GG_ROUTE, t: at(NOW + 30_000) });
  assert.deepEqual([out.mid.region, out.mid.source, out.mid.stop, out.mid.no, out.mid.buses], ['gyeonggi', 'gyeonggi', '수원역', '7770', [{ no: '7770', etasSec: [290, 1080], termMin: 6, msgs: [] }]]);
  assert.deepEqual([G.arrivalCalls(), S.at('03128')], [1, 0], '서울시에는 묻지 않음');
  const again = await live(S.svc, { gg: G.svc, route: GG_ROUTE, t: at(NOW + 70_000) });
  assert.deepEqual([again.mid.buses[0].etasSec, G.arrivalCalls()], [[250, 1040], 1], '40초 뒤: 다시 씀(흐른 초를 뺌)');
  const h = G.svc.health();
  assert.deepEqual([h.mid.cap, h.mid.callsToday, h.mid.used, h.live.used, h.callsToday.arrival], [150, 1, 2, 0, 1], '환승 버스 개수는 첫 버스(live)와 따로 · 도착 정보 하루 수에는 같이');
  // 몫 1회를 다 쓰면 mid-cap(실패로 세지 않음) · 0이면 끔
  const G1 = gyeonggi({ env: { GYEONGGI_BUS_MID_DAILY_CAP: '1' } });
  await live(S.svc, { gg: G1.svc, route: GG_ROUTE }); await G1.svc.settle();
  G1.clock.t = NOW + 30_000;
  await live(S.svc, { gg: G1.svc, route: GG_ROUTE, t: G1.clock.t });
  G1.clock.t = NOW + 100_000;
  const capped = await live(S.svc, { gg: G1.svc, route: GG_ROUTE, t: G1.clock.t });
  assert.deepEqual([capped.mid.source, capped.mid.reason, G1.arrivalCalls(), G1.svc.health().mid.failed], ['cap', 'mid-cap', 1, 0]);
  const G0 = gyeonggi({ env: { GYEONGGI_BUS_MID_DAILY_CAP: '0' } });
  await live(S.svc, { gg: G0.svc, route: GG_ROUTE }); await G0.svc.settle();
  const off = await live(S.svc, { gg: G0.svc, route: GG_ROUTE, t: NOW + 30_000 });
  assert.deepEqual([off.mid.source, off.mid.reason, G0.arrivalCalls()], ['off', 'mid-off', 0]);
});

test('어디에 묻나: 판단이 애매함 · 두 방향 · 실패 · 입력 부족이면 부르지 않음(첫 버스와 달리 서울시로도 묻지 않음) · 서울 · 인천 · 못 찾음 · 지역 없음 · 노선 없음은 서울시', async () => {
  const stub = (status, canJudge = true) => ({ keyConfigured: true, canJudge: () => canJudge, stopFor: () => ({ status }), judgedFor: () => null, noted: [], noteMid(k) { this.noted.push(k); }, midCap: 150 });
  for (const status of ['ambiguous', 'twoWay', 'failed', 'badInput']) {
    const S = seoul(), g = stub(status);
    const out = await live(S.svc, { gg: g });
    assert.deepEqual([out.mid.source, out.mid.reason, S.midCalls(), g.noted], ['nodata', 'stop', 0, ['stop']], status);
  }
  const S0 = seoul(), g0 = stub('usable', false);
  assert.deepEqual([(await live(S0.svc, { gg: g0 })).mid.reason, S0.midCalls()], ['stop', 0], '판단할 입력이 없음');
  for (const status of ['seoul', 'incheon', 'notFound', 'noRegion', 'noRoute']) {
    const S = seoul();
    const out = await live(S.svc, { gg: stub(status) });
    assert.deepEqual([out.mid.region, out.mid.source, S.midCalls()], ['seoul', 'seoul', 1], status);
  }
});

test('서울시 확인: 같은 버스 번호가 두 줄(두 방향) · 응답의 정류장 이름이 다름 → 쓰지 않음 · 이름 칸이 없으면 이름 확인만 건너뜀 · 운행 종료 · 그 버스 없음 · 정류장 번호 없음', async () => {
  const run = async (items, route = ROUTE) => { const S = seoul({ fail: respond08920(items) }); const out = await live(S.svc, { route }); return [out.mid.source, out.mid.reason ?? null, S.svc.health().mid]; };
  const [s1, r1, h1] = await run([row({ staOrd: '31' }), row({ staOrd: '58', traTime1: '400' })]);
  assert.deepEqual([s1, r1, h1.skipped.twoWay], ['nodata', 'two-way', 1]);
  const [s2, r2, h2] = await run([row({ stNm: '서울역버스환승센터' })]);
  assert.deepEqual([s2, r2, h2.skipped.mismatch], ['nodata', 'mismatch', 1]);
  const { stNm: _drop, ...noName } = row();
  const [s3] = await run([noName]);
  assert.equal(s3, 'seoul', '이름 칸 없음 → 번호 + 버스 번호로만(첫 버스와 같은 규칙)');
  const [s3b] = await run([row({ stNm: '시청앞' })]);
  assert.equal(s3b, 'seoul', "점으로 나눈 이름 중 하나가 같으면 같은 정류장('시청앞' · '시청앞.덕수궁')");
  const [s4, r4, h4] = await run([row({ arrmsg1: '운행종료', traTime1: '0', arrmsg2: '운행종료' })]);
  assert.deepEqual([s4, r4, h4.empty], ['nodata', 'no-bus', 1]);
  const [s5, r5] = await run([row({ rtNm: '402', busRouteAbrv: '402' })]);
  assert.deepEqual([s5, r5], ['nodata', 'no-bus']);
  const S = seoul();
  const noArs = await live(S.svc, { route: legWith(ROUTE, { from: { arsId: '' } }) });
  assert.deepEqual([noArs.mid.source, noArs.mid.reason, S.at(''), S.svc.health().mid.skipped.noArs], ['nodata', 'no-ars', 0, 1]);
  // 한 구간에 버스 번호가 여럿(150 · 402)이면 둘 다 — 먼저 오는 차를 계산이 고름
  const M = seoul();
  const multi = await live(M.svc, { route: legWith(ROUTE, { buses: ['150', '402'] }) });
  assert.deepEqual(multi.mid.buses.map((b) => b.no), ['150', '402']);
});

test('창 · 출발 기록 · 끄기: 출발 전 · 탑승 15분 전보다 이름 · 지남 → 부르지 않음 · SEOUL_BUS_MID_DAILY_CAP=0 → off · 몫을 다 써도 실패로 세지 않음', async () => {
  const S = seoul();
  for (const [o, reason] of [[{ departedMin: null }, 'not-departed'], [{ t: kst('2026-11-16T07:50:00') }, 'not-yet'], [{ t: kst('2026-11-16T08:31:00') }, 'passed']]) {
    const out = await live(S.svc, o);
    assert.deepEqual([out.mid.kind, out.mid.source, out.mid.reason, out.mid.buses], ['bus', 'skip', reason, []], reason);
  }
  assert.equal(S.midCalls(), 0);
  assert.deepEqual(S.svc.health().mid.skipped, { notDeparted: 1, notTransfer: 0, notYet: 1, passed: 1, line: 0, off: 0, judging: 0, stop: 0, noArs: 0, twoWay: 0, mismatch: 0 });
  const O = seoul({ env: { SEOUL_BUS_MID_DAILY_CAP: '0' } });
  const off = await live(O.svc);
  assert.deepEqual([off.mid.source, off.mid.reason, O.midCalls(), O.svc.health().mid.cap], ['off', 'mid-off', 0, 0]);
  const C = seoul({ env: { SEOUL_BUS_MID_DAILY_CAP: '1' } });
  await live(C.svc);
  C.clock.t = NOW + 70_000;
  const capped = await live(C.svc, { t: C.clock.t });
  assert.deepEqual([capped.mid.source, capped.mid.reason, C.svc.health().mid.failed], ['cap', 'mid-cap', 0]);
});

test('서버 출발 알림(planFor)에는 환승 버스 실시간이 없음(화면 요청만) · 환승 버스 정류장은 부르지 않음', async () => {
  const S = seoul();
  const dateKey = seoulParts(new Date(NOW)).dateKey;
  const user = { classes: [CLS], stop: null, prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {}, personal: { offsetMin: 0 }, arrivals: [],
    transit: { mode: 'transit', route: ROUTE }, departure: { key: arrivalKey(dateKey, CLS), at: new Date(NOW - 25 * 60_000).toISOString(), departMin: DEP, routeKey: routeKey(ROUTE) } };
  const r = await planFor(user, S.svc, new Date(NOW), { windowMin: 180 });
  assert.ok(r.live && r.departed);
  assert.equal(r.live.mid, undefined);
  assert.equal(S.midCalls(), 0);
});

test('API: /api/transit/live ?next=&at= → 환승 버스(서울시 정류장) · /api/health live.callsToday · live.mid(보호선) · gyeonggiBus.mid(개수만) · .env.example 값은 비어 있음', async () => {
  const S = seoul(), G = gyeonggi({ key: '' });
  const store = createStore(null);
  const uid = 'u0123456789abcdef0123456789abcd27';
  const dateKey = seoulParts(new Date(NOW)).dateKey;
  store.update(uid, (u) => {
    u.classes = [CLS];
    u.transit = { mode: 'transit', origin: { name: '홍대입구역', kind: 'stop' }, route: ROUTE, savedAt: new Date(NOW - 3600_000).toISOString(), retry: null };
    u.departure = { key: arrivalKey(dateKey, CLS), at: new Date(NOW - 25 * 60_000).toISOString(), departMin: DEP, routeKey: routeKey(ROUTE) };
  });
  const app = createApp({ store, provider: S.svc, pusher: { enabled: false, publicKey: null }, now: () => new Date(NOW), gyeonggi: G.svc });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => (await fetch(base + p, { headers: { 'x-user-id': uid } })).json();
  try {
    assert.equal('mid' in (await get('/api/transit/live')), false);
    const out = await get('/api/transit/live?next=3&at=490');
    assert.deepEqual([out.mid.kind, out.mid.region, out.mid.source, out.mid.no, out.mid.buses[0].etasSec, S.midCalls()], ['bus', 'seoul', 'seoul', '150', [240, 660], 1]);
    const h = await get('/api/health');
    assert.deepEqual([h.live.mid.cap, h.live.mid.callsToday, h.live.mid.used, h.live.mid.guardAt, h.live.mid.guardReached, h.live.mid.reuseSec], [100, 1, 1, 800, false, 60]);
    assert.ok(h.live.callsToday.stationinfo >= 1);
    assert.deepEqual([h.gyeonggiBus.mid.cap, h.gyeonggiBus.mid.callsToday], [150, 0]);
    const hd = JSON.stringify([h.live.mid, h.live.callsToday, h.gyeonggiBus.mid]);
    assert.ok(!hd.includes('시청') && !hd.includes('150번') && !hd.includes('08920') && !hd.includes(uid), `health에는 개수만: ${hd}`);
    assert.ok(!S.f.calls.some((u) => String(u).includes(uid)), '서울시 요청에 사용자 번호 없음');
  } finally { srv.close(); }
  const ex = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(ex, /^SEOUL_BUS_MID_DAILY_CAP=$/m);
  assert.match(ex, /^GYEONGGI_BUS_MID_DAILY_CAP=$/m);
});
