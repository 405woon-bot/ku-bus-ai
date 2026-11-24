// v2.5.0 경기도 버스 G2 점검: 첫 버스 정류장 판단(번호 + 100m · 이름 검색 · 이름 + 30m · 지역 · 경유 노선 한 방향) · 판단 보관(30일 · 1일 · 10분) ·
//   판단 전에는 지금처럼 서울시 · 출발 30분 전보다 이르면 부르지 않음(skip) · 경기도 도착(초 · 흐른 시간 · 분만 있으면 −30초 · WAIT/STOP 제외 · 방향) ·
//   서버 출발 알림도 같은 계산 · 서울 정류장은 그대로 · /api · health(개수만) · 확인 도구 판단 순서 자가 검증 · 경기도 API에 사용자 번호 안 보냄.
//   가짜 공공데이터포털 · 가짜 서울시만 씁니다. 정류장 · 노선 · 도착 값은 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGE_TTL, chooseStop, createGyeonggiBusService, digits5, sameStopName } from '../src/transit/gyeonggiBus.js';
import { transitLive } from '../src/transit/transitLive.js';
import { planFor } from '../src/planner.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { GG_FIXTURE, GG_TEST_KEY, fakeGyeonggiFetch } from './fixtures/gyeonggiFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult, planTransit } from '../../shared/transitPlan.js';
import { WALK_TABLE } from '../../shared/campusData.js';

const quiet = { warn() {}, info() {}, error() {} };
const MIN = 60_000;
const kstMs = (s) => new Date(`${s}+09:00`).getTime();
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' }; // 월요일
// 예시 경로: 첫 버스를 수원역(예시 정류장 03128) 7770으로 바꾼 '272 → 4호선 → 1213' 경로
const RESP = JSON.parse(JSON.stringify(SAMPLE_ODSAY_RESPONSE));
Object.assign(RESP.result.path[1].subPath[1], { startName: '수원역', startX: 127.0003, startY: 37.2659, startArsID: '03-128', lane: [{ busNo: '7770', type: 4, busID: 1 }] });
const GG_ROUTE = parseOdsayResult(RESP).paths[1];
const FIRST = GG_ROUTE.legs.findIndex((l) => l.kind !== 'walk');
const LEG = GG_ROUTE.legs[FIRST];
const D = planTransit({ route: GG_ROUTE, cls: CLASS, nowMin: 360, walkTable: WALK_TABLE }).pick.departMin; // 표준 계산 출발(분)
const at = (minOfDay) => kstMs(`2026-11-16T${String(Math.floor(minOfDay / 60)).padStart(2, '0')}:${String(Math.floor(minOfDay % 60)).padStart(2, '0')}:00`);
const service = ({ env = {}, fetchImpl = fakeGyeonggiFetch(), t = at(D - 10) } = {}) => {
  const clock = { t };
  const svc = createGyeonggiBusService({ env: { GYEONGGI_BUS_API_KEY: GG_TEST_KEY, ...env }, fetchImpl, clock: () => clock.t, log: quiet });
  return { svc, f: fetchImpl, clock };
};
const leg = (o = {}) => ({ ...LEG, ...o, from: { ...LEG.from, ...(o.from || {}) } });
const fakeProvider = () => {
  const calls = [];
  return {
    calls,
    stopArrivals: async (ars) => { calls.push(['stopArrivals', ars]); return { arrivals: [{ no: '7770', etasSec: [100], termMin: 10, msgs: [] }], source: 'seoul', fetchedAt: new Date().toISOString() }; },
    stopTrips: async (ars) => { calls.push(['stopTrips', ars]); return { source: 'mock', reason: 'mock', trips: [] }; },
  };
};

test('도우미: 정류장 번호 5자리 · 점으로 나뉜 경기도 이름 · 후보 고르기(번호 + 100m / 이름 + 30m / 둘 이상이면 애매함)', () => {
  assert.deepEqual([digits5('03-026'), digits5(3026), digits5('03026'), digits5('3026'), digits5(''), digits5(null)], ['03026', '03026', '03026', '', '', '']);
  assert.equal(sameStopName('고등동사거리.고등동행정복지센터.수원역푸르지오자이', '고등동사거리'), true);
  assert.equal(sameStopName('수원역.노보텔수원', '수원역(중앙)'), true);
  assert.equal(sameStopName('수원역푸르지오자이', '수원역'), false, '일부만 같으면 다른 이름');
  const S = { stationId: 202000005, stationName: '수원역', mobileNo: '03128', x: 127.0003, y: 37.2659 };
  const near = { ars: '03128', name: '수원역', lat: 37.2659, lon: 127.0003 };
  assert.deepEqual(chooseStop([S], near), { station: S, id: '202000005', d: 0, by: 'number' });
  assert.equal(chooseStop([{ ...S, y: 37.2659 + 0.0015 }], near), null, '번호가 같아도 100m 넘게 떨어지면 안 씀');
  assert.deepEqual(chooseStop([S, { ...S, stationId: 202000099 }], near), { ambiguous: true });
  assert.equal(chooseStop([S], { ...near, ars: '' }).by, 'name');
  assert.equal(chooseStop([{ ...S, x: 127.0003 + 0.0004 }], { ...near, ars: '' }), null, '이름만으로는 30m 안이어야(약 35m)');
});

test('판단: 번호 + 100m → usable(노선 · staOrder) · 주변에 없으면 이름 검색 · 번호가 없으면 이름 + 30m · 100m 밖이면 못 찾음', async () => {
  const a = service();
  const j = await a.svc.judge(LEG);
  assert.deepEqual(j, { status: 'usable', stationId: '202000005', stationName: '수원역', regionName: '수원', by: 'number', distM: 0, path: 'around', routes: [{ no: '7770', routeId: '200000085', staOrder: 18 }] }); // v2.5.1 path
  assert.deepEqual(a.f.calls.map((c) => c.op), ['getBusStationAroundListv2', 'getBusStationViaRouteListv2']);
  assert.deepEqual([a.f.calls[0].url.searchParams.get('x'), a.f.calls[0].url.searchParams.get('y')], ['127.0003', '37.2659']);
  const b = service({ fetchImpl: fakeGyeonggiFetch({ data: { getBusStationAroundListv2: [] } }) });
  assert.equal((await b.svc.judge(LEG)).status, 'usable');
  assert.deepEqual([b.f.calls.map((c) => c.op), b.f.calls[1].url.searchParams.get('keyword')], [['getBusStationAroundListv2', 'getBusStationListv2', 'getBusStationViaRouteListv2'], '수원역']);
  assert.equal((await service().svc.judge(leg({ from: { arsId: '' } }))).by, 'name');
  assert.equal((await service().svc.judge(leg({ from: { y: 37.2659 + 0.0015 } }))).status, 'notFound', '약 167m');
  assert.equal((await service({ fetchImpl: fakeGyeonggiFetch({ data: { getBusStationAroundListv2: [GG_FIXTURE.AROUND[0], { ...GG_FIXTURE.AROUND[0], stationId: 202000099 }] } }) }).svc.judge(LEG)).status, 'ambiguous');
  assert.equal((await service().svc.judge(leg({ from: { x: 'x' } }))).status, 'badInput');
});

test('판단: 지역 서울 · 인천 · 없음은 경기도로 쓰지 않음 · 버스 번호가 경유 노선에 없음 · 같은 노선 두 번 · 같은 번호 두 노선 · API 실패', async () => {
  const region = (r) => fakeGyeonggiFetch({ data: { getBusStationAroundListv2: [{ ...GG_FIXTURE.AROUND[0], regionName: r }] } });
  assert.deepEqual(await Promise.all(['서울', '인천', ''].map(async (r) => (await service({ fetchImpl: region(r) }).svc.judge(LEG)).status)), ['seoul', 'incheon', 'noRegion']);
  assert.equal((await service().svc.judge(leg({ buses: ['9999'], no: '9999' }))).status, 'noRoute');
  const twice = fakeGyeonggiFetch({ data: { getBusStationViaRouteListv2: [GG_FIXTURE.VIA[0], { ...GG_FIXTURE.VIA[0], staOrder: 77 }] } });
  assert.equal((await service({ fetchImpl: twice }).svc.judge(LEG)).status, 'twoWay', '같은 노선이 두 번 지나면 방향을 몰라 안 씀');
  const twoIds = fakeGyeonggiFetch({ data: { getBusStationViaRouteListv2: [GG_FIXTURE.VIA[0], { ...GG_FIXTURE.VIA[0], routeId: 299999999 }] } });
  assert.equal((await service({ fetchImpl: twoIds }).svc.judge(LEG)).status, 'twoWay');
  const two = service({ fetchImpl: fakeGyeonggiFetch({ data: { getBusStationViaRouteListv2: [GG_FIXTURE.VIA[0], { ...GG_FIXTURE.VIA[0], staOrder: 77 }, GG_FIXTURE.VIA[1]] } }) });
  assert.deepEqual((await two.svc.judge(leg({ buses: ['7770', '1007'] }))).routes, [{ no: '1007', routeId: '200000112', staOrder: 7 }], '쓸 수 있는 버스만 남김');
  assert.deepEqual(await service({ env: { GYEONGGI_BUS_API_KEY: 'WRONG' } }).svc.judge(LEG), { status: 'failed', reason: 'auth', aroundStatus: 'auth' }); // v2.5.1 키 문제면 이름 검색 안 함
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = createGyeonggiBusService({ env: { GYEONGGI_BUS_API_KEY: GG_TEST_KEY }, fetchImpl: hang, clock: () => at(D - 10), log: quiet, timeoutMs: 40 });
  assert.deepEqual(await slow.judge(LEG), { status: 'failed', reason: 'error', aroundStatus: 'error', keyword: '수원역' }); // v2.5.1 주변 시간 초과 → 이름 검색도 시간 초과
});

test('판단 보관: 처음엔 null(뒤에서 판단 · 이번엔 서울시) → usable 30일 · 실패는 10분 뒤 다시 · 키 없으면 판단하지 않음 · health 개수만', async () => {
  const { svc, f, clock } = service();
  assert.equal(svc.stopFor(LEG), null);
  assert.equal(svc.stopFor(LEG), null, '판단 중에 또 물어도 한 번만');
  await svc.settle();
  assert.equal(svc.stopFor(LEG).status, 'usable');
  assert.equal(f.calls.length, 2);
  clock.t += 29 * 24 * 60 * MIN;
  assert.equal(svc.stopFor(LEG).status, 'usable', '30일 동안 보관');
  clock.t += 2 * 24 * 60 * MIN;
  assert.equal(svc.stopFor(LEG), null, '30일이 지나면 다시 판단');
  await svc.settle();
  const h = svc.health();
  assert.deepEqual([h.stage, h.stops.known, h.stops.usable], ['G2', 1, 2]);
  assert.ok(!JSON.stringify(h).includes('202000005') && !JSON.stringify(h).includes('수원'), 'health에는 정류장 이름 · ID 없이 개수만');
  const bad = service({ env: { GYEONGGI_BUS_API_KEY: 'WRONG' } });
  bad.svc.stopFor(LEG); await bad.svc.settle();
  assert.equal(bad.svc.stopFor(LEG).status, 'failed');
  bad.clock.t += 11 * MIN;
  assert.equal(bad.svc.stopFor(LEG), null, '실패는 10분만 기억');
  assert.equal(JUDGE_TTL.failed, 10 * MIN);
  const nokey = createGyeonggiBusService({ env: {}, fetchImpl: f, log: quiet });
  assert.equal(nokey.stopFor(LEG), null);
  await nokey.settle();
  assert.equal(nokey.stopFor(LEG), null, '키가 없으면 판단하지 않음');
});

test('transitLive: 판단 전에는 지금처럼 서울시 → 확인 뒤 출발 30분 전보다 이르면 skip(아무것도 안 부름) → 30분 안이면 경기도 도착(초 · 흐른 시간 · 30초 공유)', async () => {
  const { svc, f, clock } = service({ t: at(D - 50) });
  const provider = fakeProvider();
  const run = () => transitLive({ route: GG_ROUTE, provider, gyeonggi: svc, nowDate: new Date(clock.t), cls: CLASS, walkTable: WALK_TABLE });
  const r0 = await run();
  assert.deepEqual([r0.first.source, r0.first.buses.map((b) => b.no), provider.calls.filter((c) => c[0] === 'stopArrivals').map((c) => c[1])], ['seoul', ['7770'], ['03128']], '판단 전: 지금처럼 서울시');
  await svc.settle();
  const r1 = await run();
  assert.deepEqual([r1.first.kind, r1.first.source, r1.first.reason, r1.first.region], ['bus', 'skip', 'not-yet', 'gyeonggi']);
  assert.deepEqual([provider.calls.filter((c) => c[0] === 'stopArrivals').length, f.calls.filter((c) => c.op === 'getBusArrivalListv2').length], [1, 0], '출발 50분 전: 서울시 · 경기도 도착 모두 안 부름');
  clock.t = at(D - 10);
  const r2 = await run();
  assert.deepEqual([r2.first.source, r2.first.region, r2.first.buses], ['gyeonggi', 'gyeonggi', [{ no: '7770', etasSec: [290, 1080], termMin: LEG.intervalMin, msgs: [] }]]);
  assert.equal(provider.calls.filter((c) => c[0] === 'stopArrivals').length, 1, '경기도 정류장으로 확인되면 서울시 번호 조회는 하지 않음(번호 겹침 방지)');
  clock.t += 20_000;
  const r3 = await run();
  assert.deepEqual([r3.first.buses[0].etasSec, f.calls.filter((c) => c.op === 'getBusArrivalListv2').length], [[270, 1060], 1], '30초 안: 받은 값에서 흐른 20초를 빼고 다시 부르지 않음');
  clock.t += 15_000;
  await run();
  assert.equal(f.calls.filter((c) => c.op === 'getBusArrivalListv2').length, 2, '30초가 지나면 다시');
  const forced = await transitLive({ route: GG_ROUTE, provider, gyeonggi: svc, nowDate: new Date(at(D - 50)), cls: CLASS, walkTable: WALK_TABLE, force: true });
  assert.equal(forced.first.source, 'gyeonggi', '?force=1(확인용)은 시간과 상관없이');
  assert.deepEqual([svc.health().live.used >= 2, svc.health().live.skipped], [true, 1]);
});

test('경기도 도착 해석: 분만 있으면 30초 일찍 · 회차지 대기(WAIT) · 운행 종료(STOP) · 다른 방향(staOrder) · 빈 값은 안 씀 → 버스가 없으면 도착 정보 없음', async () => {
  const one = (o) => [{ routeId: 200000085, routeName: '7770', staOrder: 18, flag: 'PASS', predictTime1: '', predictTimeSec1: '', predictTime2: '', predictTimeSec2: '', ...o }];
  const cases = [
    [{ predictTime1: 5 }, [[270]]],
    [{ predictTimeSec1: 100, flag: 'WAIT' }, []],
    [{ predictTimeSec1: 100, flag: 'STOP' }, []],
    [{ predictTimeSec1: 100, staOrder: 40 }, []],
    [{}, []],
    [{ predictTimeSec1: '95', predictTime2: 12 }, [[95, 690]]],
  ];
  for (const [o, want] of cases) {
    const { svc } = service({ fetchImpl: fakeGyeonggiFetch({ data: { getBusArrivalListv2: one(o) } }) });
    const j = await svc.judge(LEG);
    const r = await svc.arrivalsFor(j, LEG);
    assert.deepEqual([r.source, r.buses.map((b) => b.etasSec)], ['gyeonggi', want], JSON.stringify(o));
  }
  const { svc } = service({ fetchImpl: fakeGyeonggiFetch({ deny: ['busarrivalservice'] }) });
  const r = await svc.arrivalsFor(await svc.judge(LEG), LEG);
  assert.deepEqual([r.source, r.reason, r.buses], ['error', 'denied', []]);
  const capped = service({ env: { GYEONGGI_BUS_DAILY_CAP: '1' } });
  const jc = await capped.svc.judge(LEG);
  await capped.svc.arrivalsFor(jc, LEG); capped.clock.t += 31_000;
  assert.equal((await capped.svc.arrivalsFor(jc, LEG)).source, 'cap', '하루 상한에 닿으면 부르지 않음');
});

test('서울 정류장 · 못 찾음 · 판단 실패는 지금처럼 서울시 조회(바뀌지 않음)', async () => {
  for (const fetchImpl of [fakeGyeonggiFetch({ data: { getBusStationAroundListv2: [{ ...GG_FIXTURE.AROUND[0], regionName: '서울' }] } }), fakeGyeonggiFetch({ key: 'OTHER' }), fakeGyeonggiFetch({ data: { getBusStationAroundListv2: [], getBusStationListv2: [] } })]) {
    const { svc, clock } = service({ fetchImpl });
    const provider = fakeProvider();
    svc.stopFor(LEG); await svc.settle();
    const r = await transitLive({ route: GG_ROUTE, provider, gyeonggi: svc, nowDate: new Date(clock.t), cls: CLASS, walkTable: WALK_TABLE });
    assert.deepEqual([r.first.source, provider.calls.some((c) => c[0] === 'stopArrivals')], ['seoul', true], svc.stopFor(LEG)?.status);
  }
  // 경기도 서비스가 없거나 키가 없으면 예전과 똑같이
  const provider = fakeProvider();
  const r = await transitLive({ route: GG_ROUTE, provider, gyeonggi: null, nowDate: new Date(at(D - 10)), cls: CLASS, walkTable: WALK_TABLE });
  assert.equal(r.first.source, 'seoul');
});

test('서버 출발 알림(planFor)도 같은 계산: 경기도 도착으로 첫 버스 탑승 시각 · src live', async () => {
  const { svc, clock } = service();
  const user = { classes: [CLASS], stop: null, prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {}, personal: { offsetMin: 0 }, arrivals: [], transit: { mode: 'transit', route: GG_ROUTE } };
  await planFor(user, fakeProvider(), new Date(clock.t), { windowMin: 180, gyeonggi: svc });
  await svc.settle();
  const r = await planFor(user, fakeProvider(), new Date(clock.t), { windowMin: 180, gyeonggi: svc });
  assert.equal(r.live.first.source, 'gyeonggi');
  const s = r.rec.pick.legs.find((x) => x.i === FIRST);
  assert.deepEqual([s.src, s.vehicle], ['live', '7770']);
});

test('API: /api/transit/live 첫 버스 gyeonggi(두 번째 요청부터) · /api/health gyeonggiBus(G2 · 판단 · 사용 개수) · 경기도 API에 사용자 번호 안 보냄 · 확인 도구 판단 순서 통과', async () => {
  const fetchImpl = fakeGyeonggiFetch();
  const { svc } = service({ fetchImpl, t: at(D - 10) });
  const store = createStore(null);
  const uid = 'u0123456789abcdef0123456789abcdef';
  store.update(uid, (u) => { u.classes = [CLASS]; u.transit = { mode: 'transit', origin: { name: '수원역', kind: 'stop' }, route: GG_ROUTE, savedAt: at(D - 60), retry: null }; });
  const app = createApp({ store, provider: fakeProvider(), pusher: { enabled: false, publicKey: null }, now: () => new Date(at(D - 10)), gyeonggi: svc });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => (await fetch(base + p, { headers: { 'x-user-id': uid } })).json();
  try {
    assert.equal((await get('/api/transit/live')).first.source, 'seoul', '첫 요청: 지금처럼 서울시(판단은 뒤에서)');
    await svc.settle();
    const live = await get('/api/transit/live');
    assert.deepEqual([live.first.source, live.first.buses[0].no, live.first.buses[0].etasSec[0]], ['gyeonggi', '7770', 290]);
    const h = (await get('/api/health')).gyeonggiBus;
    assert.deepEqual([h.stage, h.stops.usable, h.live.used >= 1, h.capReached, h.quotaToday], ['G2', 1, true, false, false]);
    assert.ok(!fetchImpl.calls.some((c) => c.raw.includes(uid)), '경기도 API 요청에 사용자 번호가 없음');
    const t = await get('/api/gyeonggi/test');
    assert.deepEqual([t.ok, t.stage, t.selfJudge.status, t.selfJudge.sameStation, t.selfJudge.sameRoute, t.selfJudge.by], [true, 'G2', 'usable', true, true, 'number']);
    assert.match(t.selfJudge.result, /^판단 순서 통과/);
  } finally { srv.close(); }
});
