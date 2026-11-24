// v2.5.1 경기도 버스 G2 보완 점검: 주변 정류소(getBusStationAroundListv2)가 시간 초과 · 5xx · 형식 다름 · 기능 없음 · 잘못된 요청이면 이름 검색으로 이어서 판단 ·
//   키 · 승인 · 하루/초당 한도 · 우리 상한이면 이름 검색을 부르지 않음 · 이름 검색 목록에서는 번호 + 100m에 이름까지 같아야 · 끝까지 확실하지 않으면 '실패' ·
//   실패가 이어지면 10 → 20 → 40 → 60분 · 판단 전에는 지금처럼 서울시 · 확인 도구 selfJudge(path · aroundStatus · checks.around.status) · health judgePath · lastError.op.
//   가짜 공공데이터포털 · 가짜 서울시만 씁니다. 정류장 · 노선 · 도착 값은 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGE_TTL, chooseStop, createGyeonggiBusService, failTtl } from '../src/transit/gyeonggiBus.js';
import { transitLive } from '../src/transit/transitLive.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { GG_FIXTURE, GG_TEST_KEY, fakeGyeonggiFetch, gatewayXml } from './fixtures/gyeonggiFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult, planTransit } from '../../shared/transitPlan.js';
import { WALK_TABLE } from '../../shared/campusData.js';

const quiet = { warn() {}, info() {}, error() {} };
const MIN = 60_000, DAY = 24 * 60 * MIN;
const kstMs = (s) => new Date(`${s}+09:00`).getTime();
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' }; // 월요일
// 예시 경로: 첫 버스를 수원역(예시 정류장 03128) 7770으로 바꾼 '272 → 4호선 → 1213' 경로(v2.5.0 테스트와 같음)
const RESP = JSON.parse(JSON.stringify(SAMPLE_ODSAY_RESPONSE));
Object.assign(RESP.result.path[1].subPath[1], { startName: '수원역', startX: 127.0003, startY: 37.2659, startArsID: '03-128', lane: [{ busNo: '7770', type: 4, busID: 1 }] });
const GG_ROUTE = parseOdsayResult(RESP).paths[1];
const LEG = GG_ROUTE.legs[GG_ROUTE.legs.findIndex((l) => l.kind !== 'walk')];
const D = planTransit({ route: GG_ROUTE, cls: CLASS, nowMin: 360, walkTable: WALK_TABLE }).pick.departMin;
const at = (m) => kstMs(`2026-11-16T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}:00`);
const leg = (o = {}) => ({ ...LEG, ...o, from: { ...LEG.from, ...(o.from || {}) } });
const USABLE = { status: 'usable', stationId: '202000005', stationName: '수원역', regionName: '수원', by: 'number', distM: 0, routes: [{ no: '7770', routeId: '200000085', staOrder: 18 }] };
const ops = (f) => f.calls.map((c) => c.op);

const GW = { auth: ['SERVICE_KEY_IS_NOT_REGISTERED_ERROR', 30], denied: ['SERVICE_ACCESS_DENIED_ERROR', 20], quota: ['LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR', 22],
  rate: ['LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR', 23], endpoint: ['NO_OPENAPI_SERVICE_ERROR', 12], param: ['INVALID_REQUEST_PARAMETER_ERROR', 10] };
/** 주변 정류소만 이렇게 실패하는 가짜 API(나머지 기능은 정상 예시). hang = 끝내 답하지 않음(시간 초과) */
function aroundFails(kind, opts = {}) {
  const inner = fakeGyeonggiFetch(opts);
  const fn = (url, init) => {
    const u = new URL(String(url));
    if (!u.pathname.endsWith('/getBusStationAroundListv2')) return inner(url, init);
    inner.calls.push({ url: u, raw: String(url), service: 'busstationservice', op: 'getBusStationAroundListv2' });
    if (kind === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    if (kind === 'http500') return Promise.resolve({ ok: false, status: 500, text: async () => 'Internal Server Error' });
    if (kind === 'format') return Promise.resolve({ ok: true, status: 200, text: async () => '<html><body>잠시 후 다시</body></html>' });
    return Promise.resolve({ ok: true, status: 200, text: async () => gatewayXml(...GW[kind]) });
  };
  fn.calls = inner.calls;
  return fn;
}
const service = ({ env = {}, fetchImpl = fakeGyeonggiFetch(), t = at(D - 10), timeoutMs = 60 } = {}) => {
  const clock = { t };
  const svc = createGyeonggiBusService({ env: { GYEONGGI_BUS_API_KEY: GG_TEST_KEY, ...env }, fetchImpl, clock: () => clock.t, log: quiet, timeoutMs });
  return { svc, f: fetchImpl, clock };
};
const fakeProvider = () => {
  const calls = [];
  return {
    calls,
    stopArrivals: async (ars) => { calls.push(['stopArrivals', ars]); return { arrivals: [{ no: '7770', etasSec: [100], termMin: 10, msgs: [] }], source: 'seoul', fetchedAt: new Date().toISOString() }; },
    stopTrips: async (ars) => { calls.push(['stopTrips', ars]); return { source: 'mock', reason: 'mock', trips: [] }; },
  };
};

test('주변 정류소가 시간 초과 · 5xx · 형식 다름 · 기능 없음 · 잘못된 요청이면 이름 검색으로 이어서 판단 — 같은 결과(수원역 · 7770) · 호출 순서', async () => {
  for (const [kind, st] of [['hang', 'error'], ['http500', 'error'], ['format', 'format'], ['endpoint', 'endpoint'], ['param', 'param']]) {
    const { svc, f } = service({ fetchImpl: aroundFails(kind) });
    const j = await svc.judge(LEG);
    assert.deepEqual(j, { ...USABLE, path: 'keyword', aroundStatus: st, keyword: '수원역' }, kind);
    assert.deepEqual(ops(f), ['getBusStationAroundListv2', 'getBusStationListv2', 'getBusStationViaRouteListv2'], kind);
    assert.equal(f.calls[1].url.searchParams.get('keyword'), '수원역');
  }
});

test('키 · 승인 · 하루/초당 한도 · 우리 상한이면 이름 검색을 부르지 않고 바로 실패(같은 정류소 조회 서비스 — 호출 아끼기)', async () => {
  for (const kind of ['auth', 'denied', 'quota', 'rate']) {
    const { svc, f } = service({ fetchImpl: aroundFails(kind) });
    assert.deepEqual(await svc.judge(LEG), { status: 'failed', reason: kind, aroundStatus: kind }, kind);
    assert.deepEqual(ops(f), ['getBusStationAroundListv2'], `${kind}: 이름 검색 안 부름`);
  }
  // 우리 하루 상한(정류소 조회 1건): 앞 판단이 1건을 쓰면 다음 판단의 주변 정류소는 상한 → 이름 검색도 시도하지 않음
  const { svc, f } = service({ env: { GYEONGGI_BUS_DAILY_CAP: '1' } });
  assert.deepEqual(await svc.judge(LEG), { status: 'failed', reason: 'cap', path: 'around' }, '경유 노선에서 상한');
  assert.deepEqual(await svc.judge(LEG), { status: 'failed', reason: 'cap', aroundStatus: 'cap' });
  assert.deepEqual(ops(f), ['getBusStationAroundListv2'], '상한을 넘은 뒤에는 부르지 않음');
});

test('이름 검색 목록에서는 번호 + 100m에 이름까지 같아야 · 주변 목록에서는 지금처럼 번호 + 100m · 괄호 · 점 이름', async () => {
  const S = GG_FIXTURE.STATIONS[0], near = { ars: '03128', name: '수원역', lat: S.y, lon: S.x };
  assert.equal(chooseStop([S], { ...near, name: '매산로입구' }, { requireName: true }), null, '번호 · 거리가 맞아도 이름이 다르면 안 씀');
  assert.equal(chooseStop([S], { ...near, name: '매산로입구' }).by, 'number', '주변 목록(requireName 없음)은 지금처럼');
  assert.equal(chooseStop([S], { ...near, name: '수원역.노보텔수원' }, { requireName: true }).id, '202000005', '점으로 나뉜 이름 중 하나가 같으면');
  const other = leg({ from: { name: '매산로입구' } }); // 번호(03128) · 좌표는 수원역 그대로, 이름만 다름
  assert.deepEqual(await service().svc.judge(other), { ...USABLE, path: 'around' }, '주변 정류소로 찾으면 이름은 보지 않음(지금 그대로)');
  const none = await service({ fetchImpl: fakeGyeonggiFetch({ data: { getBusStationAroundListv2: [] } }) }).svc.judge(other);
  assert.deepEqual(none, { status: 'notFound', keyword: '매산로입구' }, '주변 정류소를 봤는데 없고, 이름 검색 목록은 이름이 달라 안 씀 → 못 찾음');
  const lost = await service({ fetchImpl: aroundFails('hang') }).svc.judge(other);
  assert.deepEqual(lost, { status: 'failed', reason: 'keyword-none', aroundStatus: 'error', keyword: '매산로입구' }, '주변 정류소를 못 봤으면 못 찾음이 아니라 실패(다시 판단)');
  const paren = await service({ fetchImpl: aroundFails('hang') }).svc.judge(leg({ from: { name: '수원역(1번 출구)' } }));
  assert.deepEqual([paren.status, paren.path, paren.keyword], ['usable', 'keyword', '수원역'], '괄호는 빼고 이름 비교');
});

test('주변 정류소를 못 받았을 때: 이름 검색에서 둘 이상이면 애매함 · 번호가 없는 경로는 이름 + 30m · 이름이 없으면 이름 검색 없이 실패', async () => {
  const twin = [GG_FIXTURE.STATIONS[0], { ...GG_FIXTURE.STATIONS[0], stationId: 202000099, x: 127.0004 }];
  const amb = await service({ fetchImpl: aroundFails('hang', { data: { getBusStationListv2: twin } }) }).svc.judge(LEG);
  assert.deepEqual(amb, { status: 'ambiguous', aroundStatus: 'error', keyword: '수원역' });
  const byName = await service({ fetchImpl: aroundFails('hang') }).svc.judge(leg({ from: { arsId: '' } }));
  assert.deepEqual([byName.status, byName.by, byName.path, byName.aroundStatus], ['usable', 'name', 'keyword', 'error']);
  const { svc, f } = service({ fetchImpl: aroundFails('hang') });
  assert.deepEqual(await svc.judge(leg({ from: { name: '' } })), { status: 'failed', reason: 'error', aroundStatus: 'error' });
  assert.deepEqual(ops(f), ['getBusStationAroundListv2']);
});

test("끝까지 확실하지 않으면 '실패'로 두고 다시 판단 — 실패가 이어지면 10 → 20 → 40 → 60분 · 다른 결과가 나오면 처음부터 · 그동안 판단 결과 없음(서울시)", async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => failTtl(n) / MIN), [10, 20, 40, 60, 60, 60]);
  assert.equal(JUDGE_TTL.failed, 10 * MIN, '첫 실패는 지금처럼 10분');
  const net = { down: true };
  const inner = fakeGyeonggiFetch();
  const fetchImpl = (url, init) => (net.down ? (inner.calls.push({ op: new URL(String(url)).pathname.split('/')[4] }), new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) : inner(url, init));
  fetchImpl.calls = inner.calls;
  const { svc, clock } = service({ fetchImpl });
  const judgeNow = async () => { assert.equal(svc.stopFor(LEG), null, '다시 판단 시작(이번 요청은 서울시)'); await svc.settle(); return svc.stopFor(LEG); };
  const waits = [];
  let r = await judgeNow();
  for (const gap of [10, 20, 40, 60, 60]) {
    assert.equal(r.status, 'failed');
    clock.t += (gap - 1) * MIN;
    assert.equal(svc.stopFor(LEG)?.status, 'failed', `${gap}분이 되기 전에는 다시 판단하지 않음`);
    clock.t += 2 * MIN;
    waits.push(gap);
    r = await judgeNow();
  }
  assert.deepEqual(waits, [10, 20, 40, 60, 60]);
  assert.equal(fetchImpl.calls.length, 12, '판단마다 주변 정류소 + 이름 검색 2건(6번)');
  net.down = false;
  clock.t += 61 * MIN;
  assert.equal((await judgeNow()).status, 'usable', '되살아나면 쓸 수 있음(30일)');
  net.down = true;
  clock.t += 30 * DAY + MIN;
  assert.equal((await judgeNow()).status, 'failed');
  clock.t += 11 * MIN;
  assert.equal(svc.stopFor(LEG), null, '성공 뒤 다시 실패하면 10분부터');
  await svc.settle();
});

test('transitLive: 판단 전에는 지금처럼 서울시 → 주변 정류소가 시간 초과여도 이름 검색으로 찾으면 다음 갱신부터 경기도 도착 정보', async () => {
  const { svc, f, clock } = service({ fetchImpl: aroundFails('hang') });
  const provider = fakeProvider();
  const run = () => transitLive({ route: GG_ROUTE, provider, gyeonggi: svc, nowDate: new Date(clock.t), cls: CLASS, walkTable: WALK_TABLE });
  assert.equal((await run()).first.source, 'seoul');
  await svc.settle();
  const r = await run();
  assert.deepEqual([r.first.source, r.first.buses.map((b) => [b.no, b.etasSec])], ['gyeonggi', [['7770', [290, 1080]]]]);
  assert.deepEqual(ops(f), ['getBusStationAroundListv2', 'getBusStationListv2', 'getBusStationViaRouteListv2', 'getBusArrivalListv2']);
  assert.equal(provider.calls.filter((c) => c[0] === 'stopArrivals').length, 1, '경기도 정류장으로 확인된 뒤에는 서울시 번호 조회 안 함');
});

test('확인 도구: ⑤ 주변 정류소가 실패하면 selfJudge가 실제 판단처럼 이름 검색으로(1건 더) · path · aroundStatus · checks.around.status / ⑤가 되면 지금 그대로', async () => {
  const bad = service({ fetchImpl: aroundFails('hang') });
  const t = await bad.svc.test();
  assert.deepEqual(t.selfJudge, { status: 'usable', path: 'keyword', aroundStatus: 'error', keyword: '수원역', by: 'number', distM: 0, regionName: '수원', sameStation: true, sameRoute: true,
    result: '판단 순서 통과(번호 · 거리 · 지역 · 노선 — 주변 정류소 대신 이름 검색)' });
  assert.deepEqual([t.checks.around.status, t.checks.around.count, t.steps[4].status, t.ok], ['error', 0, 'error', true]);
  assert.deepEqual(bad.svc.health().callsToday, { station: 4, arrival: 1, route: 1 }, '⑤가 실패할 때만 이름 검색 1건 더');
  assert.deepEqual(bad.svc.health().judgePath, { around: 0, keyword: 0, aroundFailed: 0 }, '확인 도구는 판단 개수에 넣지 않음');
  const good = service();
  const g = await good.svc.test();
  assert.deepEqual([g.selfJudge.path, g.selfJudge.aroundStatus, g.selfJudge.result, g.checks.around.status], ['around', undefined, '판단 순서 통과(번호 · 거리 · 지역 · 노선)', 'ok']);
  assert.deepEqual(good.svc.health().callsToday, { station: 3, arrival: 1, route: 1 }, '⑤가 되면 지금처럼 5건');
});

test('health · API: judgePath(주변 · 이름 검색 · 주변 실패 개수) · lastError.op(어느 기능) · 정류장 이름 · ID · 키 없음', async () => {
  const { svc } = service({ fetchImpl: aroundFails('hang') });
  svc.stopFor(LEG); await svc.settle();
  const h = svc.health();
  assert.deepEqual([h.judgePath, h.stops.usable, h.lastError.op, h.lastError.kind, h.lastError.service], [{ around: 0, keyword: 1, aroundFailed: 1 }, 1, 'getBusStationAroundListv2', 'error', '경기도_정류소 조회']);
  const dump = JSON.stringify(h);
  assert.ok(!dump.includes('수원') && !dump.includes('202000005') && !dump.includes('03128') && !dump.includes(GG_TEST_KEY) && !dump.includes(encodeURIComponent(GG_TEST_KEY)), dump);
  const ok = service();
  ok.svc.stopFor(LEG); await ok.svc.settle();
  assert.deepEqual([ok.svc.health().judgePath, ok.svc.health().lastError], [{ around: 1, keyword: 0, aroundFailed: 0 }, null]);
  const app = createApp({ store: createStore(null), provider: fakeProvider(), pusher: { enabled: false, publicKey: null }, now: () => new Date(at(D - 10)), gyeonggi: svc });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  try {
    const gb = (await (await fetch(`http://127.0.0.1:${srv.address().port}/api/health`)).json()).gyeonggiBus;
    assert.deepEqual([gb.stage, gb.judgePath, gb.lastError.op], ['G2', { around: 0, keyword: 1, aroundFailed: 1 }, 'getBusStationAroundListv2']);
  } finally { srv.close(); }
});
