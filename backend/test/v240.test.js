// v2.4.0 경기도 버스 G1 점검: 응답 해석(감싼 · 평평한 JSON · 한 건 객체 · 결과 없음 · 게이트웨이 오류 · HTTP · 형식 다름) ·
//   확인 도구(고정 입력 '수원역' → 5건 · https · serviceKey 한 번만 인코딩 · format=json · 서비스별 판정 · 형식 확인 · 차량 번호 값 없음 · 키 가림) ·
//   키 미등록이면 첫 호출에서 멈춤 · 한 서비스만 미승인 · 검색 결과 없음 → 공식 예제 값 · 하루 3번(외부 DB) · 10분 보관 · 상한 · /api · health.
//   가짜 공공데이터포털만 씁니다(실제 호출 없음). 값은 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GG_TEST, createGyeonggiBusService, parseGbis } from '../src/transit/gyeonggiBus.js';
import { createKv } from '../src/transit/kv.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createMockProvider } from '../src/transit/index.js';
import { GG_TEST_KEY, fakeGyeonggiFetch, gatewayXml, gbisJson } from './fixtures/gyeonggiFixture.js';

const quiet = { warn() {}, info() {}, error() {} };
const kst = (s) => new Date(`${s}+09:00`).getTime();
const MIN = 60_000;
const service = ({ env = {}, fetchImpl = fakeGyeonggiFetch(), at = kst('2026-11-24T13:00:00'), kv = null, timeoutMs } = {}) => {
  const clock = { t: at };
  const svc = createGyeonggiBusService({ env: { GYEONGGI_BUS_API_KEY: GG_TEST_KEY, ...env }, fetchImpl, clock: () => clock.t, log: quiet, kv, ...(timeoutMs ? { timeoutMs } : {}) });
  return { svc, f: fetchImpl, clock };
};
const noKey = (x) => { const s = JSON.stringify(x); return !s.includes(GG_TEST_KEY) && !s.includes(encodeURIComponent(GG_TEST_KEY)); };

test('응답 해석: 감싼 JSON(response · msgHeader · msgBody) · 평평한 JSON(GBIS 매뉴얼 표) · 한 건은 객체 · 결과 없음(4) · 필수 값 없음(2)', () => {
  const items = [{ stationId: 1, stationName: '가' }, { stationId: 2, stationName: '나' }];
  const w = parseGbis(JSON.stringify(gbisJson('busStationList', items)));
  assert.deepEqual([w.status, w.code, w.items.length, w.shape.list, w.shape.response, w.shape.header], ['ok', '0', 2, 'busStationList', ['comMsgHeader', 'msgHeader', 'msgBody'], ['queryTime', 'resultCode', 'resultMessage']]);
  const flat = parseGbis(JSON.stringify(gbisJson('busArrivalList', items, { envelope: 'flat' })));
  assert.deepEqual([flat.status, flat.items.length, flat.shape.list, flat.shape.header, flat.shape.top.includes('resultCode')], ['ok', 2, 'busArrivalList', null, true]);
  const one = parseGbis(JSON.stringify(gbisJson('busRouteList', [items[0]], { single: true })));
  assert.deepEqual([one.status, one.items, one.shape.single], ['ok', [items[0]], true], '한 건이면 목록 대신 객체로 와도 목록으로');
  assert.deepEqual([parseGbis(JSON.stringify(gbisJson('busArrivalList', [], { resultCode: 4 }))).status, parseGbis(JSON.stringify(gbisJson('busArrivalList', [], { resultCode: 2 }))).status,
    parseGbis(JSON.stringify(gbisJson('busArrivalList', [], { resultCode: 1 }))).status, parseGbis(JSON.stringify(gbisJson('busArrivalList', [], { resultCode: 9 }))).status], ['nodata', 'param', 'error', 'api']);
  assert.equal(parseGbis(JSON.stringify({ response: { msgHeader: { resultCode: '00', resultMessage: 'NORMAL SERVICE.' }, msgBody: { busStationList: items } } })).status, 'ok', "'00'도 정상");
  assert.equal(parseGbis(JSON.stringify({ response: { msgHeader: { resultCode: 0 }, msgBody: { anotherList: items } } })).items.length, 2, '처음 보는 목록 이름이어도 객체 목록이면 씀');
});

test('응답 해석: 공공데이터포털 게이트웨이 오류(XML) · HTTP 상태 · XML 결과 코드 · 형식 다름 · 객체 기본 이름은 섞이지 않음', () => {
  const g = (name, code) => parseGbis(gatewayXml(name, code)).status;
  assert.deepEqual([g('SERVICE_KEY_IS_NOT_REGISTERED_ERROR', 30), g('SERVICE_ACCESS_DENIED_ERROR', 20), g('LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR', 22),
    g('LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR', 23), g('NO_OPENAPI_SERVICE_ERROR', 12), g('INVALID_REQUEST_PARAMETER_ERROR', 10), g('DEADLINE_HAS_EXPIRED_ERROR', 31), g('SERVICE_KEY_IS_NULL', 20)],
  ['auth', 'denied', 'quota', 'rate', 'endpoint', 'param', 'auth', 'auth']);
  assert.equal(parseGbis(JSON.stringify({ response: { header: { resultCode: '30', resultMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' } } })).status, 'auth', 'JSON으로 와도 이름으로 찾음');
  assert.deepEqual([parseGbis('Unauthorized', 401).status, parseGbis('Forbidden', 403).status, parseGbis('', 429).status, parseGbis('API not found', 404).status, parseGbis('oops', 500).status],
    ['auth', 'auth', 'rate', 'endpoint', 'error']);
  assert.deepEqual([parseGbis('<response><msgHeader><resultCode>4</resultCode><resultMessage>결과가 존재하지 않습니다.</resultMessage></msgHeader></response>').status,
    parseGbis('<html><body>점검 중</body></html>').status, parseGbis('').status, parseGbis('{"a":1}').status], ['nodata', 'format', 'format', 'format']);
  const odd = parseGbis(JSON.stringify({ response: { msgHeader: { resultCode: 0 }, msgBody: { busStationList: [{ ['__proto__']: 1, stationId: 3 }] } } }));
  assert.deepEqual([odd.status, ({}).stationId], ['ok', undefined]);
});

test('G1 확인 도구: 고정 입력(수원역) → 도착 · 경유 노선 · 주변 · 노선 정류소 — 5건 · https · serviceKey 한 번만 인코딩 · format=json · 판정 · 형식 확인 · 차량 번호 값 없음 · 키 없음', async () => {
  const { svc, f } = service();
  const r = await svc.test();
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.map((c) => c.op), ['getBusStationListv2', 'getBusArrivalListv2', 'getBusStationViaRouteListv2', 'getBusStationAroundListv2', 'getBusRouteStationListv2']);
  for (const c of f.calls) {
    assert.ok(c.raw.startsWith('https://apis.data.go.kr/6410000/'), c.raw.replace(/serviceKey=[^&]*/, 'serviceKey=…'));
    assert.ok(c.raw.includes('serviceKey=GG%2BTEST%2FKEY%3D%3D&'), 'Decoding 키(+ / =)는 한 번만 인코딩');
    assert.equal(c.url.searchParams.get('format'), 'json');
  }
  assert.equal(f.calls[0].url.searchParams.get('keyword'), '수원역');
  assert.deepEqual([f.calls[1].url.searchParams.get('stationId'), f.calls[4].url.searchParams.get('routeId'), f.calls[3].url.searchParams.get('x'), f.calls[3].url.searchParams.get('y')],
    ['202000005', '200000085', '127.0003', '37.2659'], '고른 정류장 · 그 정류장을 지나는 첫 노선 · 그 좌표로');
  assert.deepEqual(Object.fromEntries(Object.entries(r.services).map(([k, v]) => [k, [v.name, v.status, v.result]])), {
    station: ['경기도_정류소 조회', 'ok', '작동'], arrival: ['경기도_버스도착정보 조회', 'ok', '작동'], route: ['경기도_버스노선 조회', 'ok', '작동'] });
  assert.deepEqual(r.picked, { from: 'keyword', stationId: '202000005', stationName: '수원역', mobileNo: '03128', regionName: '수원', x: '127.0003', y: '37.2659' });
  assert.deepEqual(r.checks, {
    arrivalSeconds: { withSeconds: 2, of: 2 }, around: { status: 'ok', count: 3, distanceField: true, maxDistance: 187 }, // v2.5.1 status
    route: { routeId: '200000085', fromVia: true, stations: 25, hasPickedStation: true, stationSeq: 18, viaStaOrder: 18, staOrderMatches: true, districtCd: { 1: 3, 2: 22 } } });
  const arrival = r.steps.find((s) => s.op === 'getBusArrivalListv2');
  assert.deepEqual([arrival.shape.list, arrival.shape.header, arrival.fields.includes('predictTimeSec1'), arrival.sample.predictTimeSec1, arrival.sample.routeName], ['busArrivalList', ['queryTime', 'resultCode', 'resultMessage'], true, 290, '7770']);
  assert.ok(!('plateNo1' in arrival.sample) && !('vehId1' in arrival.sample) && !JSON.stringify(r).includes('경기70아'), '차량 번호 · 차량 ID 값은 싣지 않음(필드 이름만)');
  assert.deepEqual([r.stage, r.runsToday, r.maxPerDay, r.cached], ['G2', 1, 3, false], 'v2.5.0부터 G2');
  assert.ok(noKey(r) && noKey(svc.health()));
  assert.deepEqual(svc.health().callsToday, { station: 3, arrival: 1, route: 1 });
});

test('키 모양: Encoding 키(% 포함)는 그대로 · 평평한 응답 · 한 건 객체도 같은 판정', async () => {
  const enc = encodeURIComponent(GG_TEST_KEY);
  const a = service({ env: { GYEONGGI_BUS_API_KEY: enc } });
  assert.equal((await a.svc.test()).ok, true);
  assert.ok(a.f.calls.every((c) => c.raw.includes(`serviceKey=${enc}&`)) && !a.f.calls.some((c) => c.raw.includes('%252B')), '두 번 인코딩하지 않음');
  const flat = service({ fetchImpl: fakeGyeonggiFetch({ envelope: 'flat', single: true }) });
  const r = await flat.svc.test();
  assert.deepEqual([r.ok, r.steps[0].shape.header, r.steps[0].shape.list], [true, null, 'busStationList']);
});

test('키 미등록(SERVICE_KEY_IS_NOT_REGISTERED_ERROR): 첫 호출에서 멈춤(1건) · 키가 아직 안 통한다는 안내 · 10분 보관 · health 마지막 오류(키 없음)', async () => {
  const { svc, f, clock } = service({ env: { GYEONGGI_BUS_API_KEY: 'WRONG+KEY' } });
  const r = await svc.test();
  assert.deepEqual([r.ok, r.reason, f.calls.length, r.steps.map((s) => s.status)], [false, 'auth', 1, ['auth', 'skipped', 'skipped', 'skipped', 'skipped']]);
  assert.match(r.services.station.result, /키가 아직 통하지 않아요/);
  assert.deepEqual([r.services.arrival.status, r.services.route.status, r.checks], ['skipped', 'skipped', null]);
  assert.equal((await svc.test()).cached, true);
  clock.t += 5 * MIN;
  assert.equal(f.calls.length, 1, '10분 안에는 다시 부르지 않음');
  const h = svc.health();
  assert.deepEqual([h.lastError.kind, h.lastError.service, h.keyConfigured], ['auth', '경기도_정류소 조회', true]);
  assert.ok(!JSON.stringify(h).includes('WRONG') && !JSON.stringify(r).includes('WRONG'));
});

test('한 서비스만 승인 안 됨(SERVICE_ACCESS_DENIED_ERROR) → 그 서비스만 denied · 도착 결과 없음(4)은 작동(결과 없음) · 검색 결과 없음 → 공식 예제 값', async () => {
  const d = service({ fetchImpl: fakeGyeonggiFetch({ deny: ['busarrivalservice'] }) });
  const r = await d.svc.test();
  assert.deepEqual([r.ok, r.reason, r.services.arrival.status, r.services.station.status, r.services.route.status], [false, 'denied', 'denied', 'ok', 'ok']);
  assert.match(r.services.arrival.result, /활용신청 · 승인 상태/);
  const n = service({ fetchImpl: fakeGyeonggiFetch({ nodata: ['getBusArrivalListv2'] }) });
  const rn = await n.svc.test();
  assert.deepEqual([rn.ok, rn.services.arrival.status, rn.checks.arrivalSeconds], [true, 'nodata', { withSeconds: 0, of: 0 }]);
  assert.match(rn.services.arrival.result, /^작동\(결과 없음/);
  const k = service({ fetchImpl: fakeGyeonggiFetch({ nodata: ['getBusStationListv2', 'getBusStationViaRouteListv2'] }) });
  const rk = await k.svc.test();
  assert.deepEqual([rk.picked.from, rk.picked.stationId, k.f.calls[1].url.searchParams.get('stationId'), k.f.calls.at(-1).url.searchParams.get('routeId'), rk.checks.route.fromVia],
    ['fallback', GG_TEST.fallbackStationId, '200000177', '200000037', false], '이름 검색 결과가 없으면 공식 안내의 예제 정류소 · 노선');
});

test('하루 3번(외부 DB 카운터) · 10분 보관 · 다음 날 초기화 · 서비스별 상한(cap) · 키 없음은 부르지 않음(횟수도 안 씀)', async () => {
  const kv = createKv();
  const { svc, f, clock } = service({ kv });
  await svc.test();
  assert.deepEqual([(await svc.test()).cached, f.calls.length], [true, 5]);
  clock.t += 11 * MIN; await svc.test();
  clock.t += 11 * MIN; await svc.test();
  clock.t += 11 * MIN;
  const over = await svc.test();
  assert.deepEqual([over.ok, over.reason, over.runsToday, f.calls.length], [false, 'test-limit', 3, 15]);
  assert.equal(await kv.getNum('kubusai:gg:test:2026-11-24'), 3);
  assert.deepEqual([await kv.getNum('kubusai:gg:calls:station:2026-11-24'), await kv.getNum('kubusai:gg:calls:arrival:2026-11-24'), await kv.getNum('kubusai:gg:calls:route:2026-11-24')], [9, 3, 3]);
  const again = createGyeonggiBusService({ env: { GYEONGGI_BUS_API_KEY: GG_TEST_KEY }, kv, fetchImpl: f, clock: () => clock.t, log: quiet });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await again.test()).reason, 'test-limit', '재시작해도 하루 3번');
  clock.t = kst('2026-11-25T13:00:00');
  assert.deepEqual([(await svc.test()).ok, svc.health().test.runsToday, svc.health().callsToday], [true, 1, { station: 3, arrival: 1, route: 1 }]);
  const capped = service({ env: { GYEONGGI_BUS_DAILY_CAP: '2' } });
  const c = await capped.svc.test();
  assert.deepEqual([c.steps.map((s) => [s.op, s.status]).at(-1), c.steps.filter((s) => s.status === 'ok').length, capped.f.calls.length], [['getBusStationAroundListv2', 'cap'], 4, 4], '정류소 서비스 세 번째 호출(주변 정류소)부터 cap — 부르지 않음');
  const nokey = createGyeonggiBusService({ env: {}, fetchImpl: f, log: quiet });
  assert.deepEqual([(await nokey.test()).reason, nokey.health().keyConfigured, nokey.health().test.runsToday], ['no-key', false, 0]);
});

test('시간 초과 · 연결 실패는 error(키 가림) · 심야엔 도착이 비어 있을 수 있다는 안내만(시험은 함)', async () => {
  const base = fakeGyeonggiFetch();
  const hang = async (url, opts) => (String(url).includes('getBusArrivalListv2')
    ? new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    : base(url, opts));
  const slow = service({ fetchImpl: hang, timeoutMs: 50 });
  const r = await slow.svc.test();
  assert.deepEqual([r.ok, r.services.arrival.status], [false, 'error']);
  assert.match(r.steps[1].resultMessage, /0\.05초 안에 답하지 않았어요/);
  const boom = (u, raw) => { if (u.pathname.endsWith('getBusRouteStationListv2')) throw new Error(`connect failed ${raw}`); return null; };
  const b = service({ fetchImpl: fakeGyeonggiFetch({ respond: boom }) });
  const rb = await b.svc.test();
  assert.deepEqual([rb.services.route.status, noKey(rb), noKey(b.svc.health())], ['error', true, true], '오류 글에 주소가 섞여도 키는 가림');
  const night = service({ at: kst('2026-11-24T02:10:00') });
  const rn = await night.svc.test();
  assert.deepEqual([rn.ok, typeof rn.nightNote], [true, 'string']);
});

test('API: GET /api/gyeonggi/test · /api/health gyeonggiBus(G1 · 상한 · 캐시 초 · 호출 수 · 시험 횟수) · 서비스 없으면 no-service · 키 없음 · .env.example 값 비움', async () => {
  const { svc } = service({ env: { GYEONGGI_BUS_DAILY_CAP: '900', GYEONGGI_BUS_CACHE_SEC: '30' } });
  const run = async (gyeonggi, fn) => {
    const app = createApp({ store: createStore(null), provider: createMockProvider('jeongneung'), pusher: { enabled: false, publicKey: null }, now: () => new Date(kst('2026-11-24T13:00:00')), gyeonggi });
    const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
    try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
  };
  await run(svc, async (base) => {
    const t = await (await fetch(`${base}/api/gyeonggi/test`)).json();
    assert.deepEqual([t.ok, t.services.arrival.result, t.steps.length], [true, '작동', 5]);
    const h = (await (await fetch(`${base}/api/health`)).json()).gyeonggiBus;
    assert.deepEqual([h.keyConfigured, h.stage, h.cap, h.cacheSec, h.callsToday, h.test.runsToday, h.test.maxPerDay], [true, 'G2', 900, 30, { station: 3, arrival: 1, route: 1 }, 1, 3], 'v2.5.0부터 G2 · 판단 순서 자가 검증은 받은 응답을 다시 써서 호출 수 그대로');
    assert.ok(noKey(t) && noKey(h));
  });
  await run(null, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/gyeonggi/test`)).json(), { ok: false, reason: 'no-service' });
    assert.deepEqual((await (await fetch(`${base}/api/health`)).json()).gyeonggiBus, { keyConfigured: false });
  });
  const ex = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const k of ['GYEONGGI_BUS_API_KEY', 'GYEONGGI_BUS_DAILY_CAP', 'GYEONGGI_BUS_CACHE_SEC']) assert.match(ex, new RegExp(`^${k}=$`, 'm'), `${k} 값 비움`);
});
