// v2.0 출발지 환승 경로: ODsay(키 인코딩 · Referer · 30일 전역 캐시 · 하루 상한 · 오류 → 직행 안내) · 서울시 실시간 지하철(캐시 · 상한) ·
// 실시간 재료(transitLive) · API(/api/transit/search · /api/me/transit · /api/transit/live · /api/plan · /api/health) · 서버 출발 알림
// 가짜 ODsay · 가짜 서울시 지하철 · 가짜 Upstash만 씁니다(실제 서버 호출 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOdsayService } from '../src/transit/odsay.js';
import { createSubwayService } from '../src/transit/seoulSubway.js';
import { createKv } from '../src/transit/kv.js';
import { createUpstash } from '../src/upstash.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService, createMockProvider } from '../src/transit/index.js';
import { planFor } from '../src/planner.js';
import { fakeOdsayFetch, ODSAY_REFERER, ODSAY_TEST_KEY } from './fixtures/odsayFixture.js';
import { fakeSubwayFetch, SUBWAY_TEST_KEY } from './fixtures/subwayFixture.js';
import { fakeSeoulFetch } from './fixtures/seoulFixture.js';
import { UPSTASH_URL, fakeUpstashFetch } from './fixtures/upstashFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult, planTransit } from '../../shared/transitPlan.js';
import { WALK_TABLE } from '../../shared/campusData.js';
import { seoulParts, toHHMM } from '../../shared/time.js';

const quiet = { warn() {}, info() {}, error() {} };
const kst = (s) => new Date(`${s}+09:00`);
const HONGDAE = { lat: 37.557527, lon: 126.923778, name: '홍대입구역', kind: 'stop' };
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const mk = ({ env = {}, fetchImpl = fakeOdsayFetch(), kv = createKv(), clock } = {}) => ({
  fetchImpl, kv, svc: createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY, ...env }, kv, fetchImpl, log: quiet, ...(clock ? { clock } : {}) }),
});
const noKey = (x) => { const s = JSON.stringify(x); return !s.includes(ODSAY_TEST_KEY) && !s.includes(encodeURIComponent(ODSAY_TEST_KEY)); };

test('ODsay 요청: 키는 encodeURIComponent(+ · / · =) · 모든 요청에 Referer · 출발(SX,SY) → 국민대 정문(EX 126.9972, EY 37.6109)', async () => {
  const { svc, fetchImpl } = mk();
  const r = await svc.search(HONGDAE);
  assert.deepEqual([r.ok, r.cached, r.paths.length, r.paths[0].title], [true, false, 3, '2호선 → 4호선 → 1213']);
  const c = fetchImpl.calls[0];
  assert.ok(c.raw.includes('apiKey=ODSAY%2BTEST%2FKEY%3D'), c.raw.replace(/apiKey=.*/, 'apiKey=…'));
  assert.equal(c.referer, 'https://ku-bus-ai.onrender.com');
  assert.deepEqual(['SX', 'SY', 'EX', 'EY', 'OPT', 'SearchType', 'SearchPathType'].map((k) => c.url.searchParams.get(k)), ['126.923778', '37.557527', '126.9972', '37.6109', '0', '0', '0']);
  // 키를 인코딩하지 않으면 '+'가 공백이 되어 인증 실패(실제 ODsay와 같은 흉내) — 우리 요청은 이 문제가 없음
  const raw = await fetchImpl(c.raw.replace('ODSAY%2BTEST%2FKEY%3D', 'ODSAY+TEST/KEY='), { headers: { Referer: ODSAY_REFERER } });
  assert.match(await raw.text(), /ApiKeyAuthFailed/);
  const other = mk({ env: { ODSAY_REFERER: 'https://example.test' }, fetchImpl: fakeOdsayFetch({ referer: 'https://example.test' }) });
  assert.equal((await other.svc.search(HONGDAE)).ok, true);
  assert.equal(other.fetchImpl.calls[0].referer, 'https://example.test');
  assert.ok(noKey(svc.health()) && noKey(r));
});

test('같은 출발지는 다시 부르지 않음: 이름이 같고 1km 안 · 또는 GPS 300m 안이면 저장한 결과(모든 사용자 공통) — 먼 곳의 같은 이름은 새로', async () => {
  const { svc, fetchImpl } = mk();
  const a = await svc.search(HONGDAE);
  const b = await svc.search({ ...HONGDAE, lat: HONGDAE.lat + 0.004 }); // 같은 이름 · 약 450m
  assert.deepEqual([b.cached, b.searchId, fetchImpl.calls.length], [true, a.searchId, 1]);
  const g1 = await svc.search({ lat: HONGDAE.lat + 0.0022, lon: HONGDAE.lon, kind: 'gps' }); // 약 245m
  assert.deepEqual([g1.cached, g1.origin.name, fetchImpl.calls.length], [true, '홍대입구역', 1]);
  const g2 = await svc.search({ lat: HONGDAE.lat + 0.0036, lon: HONGDAE.lon, kind: 'gps' }); // 약 400m
  assert.deepEqual([g2.cached, g2.origin.name, fetchImpl.calls.length], [false, 'GPS로 고른 위치', 2]);
  const far = await svc.search({ ...HONGDAE, lat: 37.5, lon: 127.0 }); // 같은 이름, 수 km 떨어짐
  assert.deepEqual([far.cached, fetchImpl.calls.length], [false, 3]);
  assert.deepEqual([svc.health().cacheHits, svc.health().cachedOrigins], [2, 3]);
  assert.equal((await svc.byId(a.searchId)).paths.length, 3);
  assert.equal(await svc.byId('../etc'), null);
});

test('하루 새 호출 상한(기본 25, 최대 30): 넘으면 부르지 않고 직행 안내 · 저장된 출발지는 계속 · 다음 날 다시', async () => {
  let t = Date.parse('2026-11-16T08:00:00+09:00');
  const { svc, fetchImpl } = mk({ env: { ODSAY_DAILY_CAP: '2' }, clock: () => t, kv: createKv({ clock: () => t }) });
  const spot = (d) => ({ lat: 37.55 + d, lon: 126.92, kind: 'gps' });
  const r = [];
  for (const d of [0, 0.01, 0.02]) r.push(await svc.search(spot(d)));
  assert.deepEqual(r.map((x) => x.ok), [true, true, false]);
  assert.deepEqual([r[2].fallback, r[2].reason, fetchImpl.calls.length], ['direct', 'cap', 2]);
  assert.match(r[2].message, /오늘 새 경로 검색 한도\(2회\).*내일부터 찾을 수 있어요/);
  assert.ok(!/직행/.test(r[2].message), 'v2.1: 근처 국민대행 정류장이 있을 때만 화면이 직행 안내를 덧붙임');
  assert.equal((await svc.search(spot(0))).cached, true, '저장된 출발지는 상한과 상관없이');
  assert.deepEqual([svc.health().callsToday, svc.health().left, svc.health().lastFallback.reason], [2, 0, 'cap']);
  t += 86400_000;
  assert.equal((await svc.search(spot(0.03))).ok, true, '날짜가 바뀌면 다시');
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(mk().svc.health().cap, 25);
  assert.equal(mk({ env: { ODSAY_DAILY_CAP: '99' } }).svc.health().cap, 30);
});

test('외부 DB(Upstash): 검색 결과(30일) · 하루 호출 수가 서버를 다시 켜도 그대로', async () => {
  const data = {};
  const up = () => createKv({ upstash: createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch({ data }) }) });
  const s1 = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv: up(), fetchImpl: fakeOdsayFetch(), log: quiet });
  const a = await s1.search(HONGDAE);
  const day = seoulParts(new Date()).dateKey;
  assert.equal(data[`kubusai:odsay:calls:${day}`].$s, '1');
  const res = data[`kubusai:odsay:r:${a.searchId}`];
  assert.ok(res && res.$exp - Date.now() > 29 * 86400_000, '30일 보관');
  assert.ok(!res.$s.includes('passStopList'), '줄인 경로만 저장(원본 응답 아님)');
  const f2 = fakeOdsayFetch();
  const s2 = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv: up(), fetchImpl: f2, log: quiet });
  await new Promise((r) => setTimeout(r, 20));
  const b = await s2.search({ lat: HONGDAE.lat, lon: HONGDAE.lon, kind: 'gps' });
  assert.deepEqual([b.cached, b.searchId, f2.calls.length, s2.health().callsToday, s2.health().store], [true, a.searchId, 0, 1, 'upstash']);
});

test('ODsay 오류 → 예외 대신 직행 안내: 키 인증 · 700m 안(-98) · 경로 없음(-99, 7일 기억) · 지역 밖 · HTTP 오류 · 형식 — 키는 어디에도 없음', async () => {
  const cases = [
    [{ error: [{ code: '500', message: '[ApiKeyAuthFailed] ApiKey authentication failed.' }] }, 'auth'],
    [{ error: { code: '-98', msg: '출발지와 도착지가 너무 가깝습니다.' } }, 'near'],
    [{ error: { code: '-99', msg: '검색결과가 없습니다.' } }, 'no-path'],
    [{ error: [{ code: '6', message: '서비스 지역이 아닙니다.' }] }, 'out-of-area'],
    [{ status: 503, ok: false, text: async () => `down ${ODSAY_TEST_KEY}` }, 'error'],
    [{ result: { nothing: true } }, 'error'],
  ];
  for (const [resp, reason] of cases) {
    const { svc } = mk({ fetchImpl: fakeOdsayFetch({ respond: () => resp }) });
    const r = await svc.search(HONGDAE);
    assert.deepEqual([r.ok, r.fallback, r.reason], [false, 'direct', reason], reason);
    assert.ok(r.message.length > 5);
    assert.ok(noKey(svc.health()) && noKey(r), reason);
  }
  const f = fakeOdsayFetch({ respond: () => ({ error: { code: '-99', msg: '검색결과가 없습니다.' } }) });
  const { svc } = mk({ fetchImpl: f });
  await svc.search(HONGDAE);
  const again = await svc.search(HONGDAE);
  assert.deepEqual([again.reason, again.cached, f.calls.length], ['no-path', true, 1], '경로 없음도 기억해 다시 부르지 않음');
});

test('키 없음 · 국민대 700m 안 · 잘못된 좌표: 부르지 않고 바로 안내', async () => {
  const f = fakeOdsayFetch();
  const none = createOdsayService({ env: {}, kv: createKv(), fetchImpl: f, log: quiet });
  assert.deepEqual([(await none.search(HONGDAE)).reason, none.health().keyConfigured], ['no-key', false]);
  const { svc, fetchImpl } = mk();
  const near = await svc.search({ lat: 37.6085, lon: 127.0002, name: '청덕초등학교입구' });
  assert.deepEqual([near.reason, near.distM < 700, fetchImpl.calls.length], ['near', true, 0]);
  assert.equal((await svc.search({ lat: 'x', lon: 1 })).reason, 'bad');
  assert.equal(f.calls.length, 0);
});

test('실시간 지하철: http 주소 · 역 이름 인코딩 · 30초 캐시 · 이름이 안 맞으면 괄호 뺀 이름으로 한 번 더 · 인증 오류 · 하루 상한 · 키 없음', async () => {
  let t = Date.parse('2026-11-16T08:00:00+09:00');
  const f = fakeSubwayFetch({ clock: () => t });
  const svc = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: f, clock: () => t, log: quiet });
  const a = await svc.arrivals('홍대입구');
  assert.deepEqual([a.source, a.rows.length, a.rows[0].next, a.rows[0].etaSec], ['seoul', 2, '신촌', 150]);
  assert.ok(f.calls[0].raw.startsWith(`http://swopenapi.seoul.go.kr/api/subway/${SUBWAY_TEST_KEY}/json/realtimeStationArrival/0/20/%ED%99%8D`));
  await svc.arrivals('홍대입구');
  assert.equal(f.calls.length, 1, '30초 안에는 캐시');
  t += 31_000;
  await svc.arrivals('홍대입구');
  assert.equal(f.calls.length, 2);
  assert.equal((await svc.arrivals('총신대입구(이수)')).source, 'seoul');
  const none = await svc.arrivals('없는역(예시)');
  assert.deepEqual([none.source, f.calls.filter((x) => x.station.startsWith('없는')).map((x) => x.station)], ['nodata', ['없는역(예시)', '없는']], '괄호 · 끝의 역을 뺀 이름으로 한 번 더');
  assert.equal(svc.health().callsToday, 5);
  const bad = createSubwayService({ env: { SEOUL_SUBWAY_KEY: 'WRONG-KEY' }, fetchImpl: fakeSubwayFetch(), log: quiet });
  assert.deepEqual([(await bad.arrivals('홍대입구')).source, bad.health().lastError.kind], ['error', 'auth']);
  assert.ok(!JSON.stringify(bad.health()).includes('WRONG-KEY'));
  const capped = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY, SEOUL_SUBWAY_DAILY_CAP: '1' }, fetchImpl: fakeSubwayFetch(), log: quiet });
  await capped.arrivals('홍대입구');
  assert.equal((await capped.arrivals('총신대입구(이수)')).source, 'cap');
  assert.equal((await createSubwayService({ env: {} }).arrivals('홍대입구')).source, 'off');
});

// API 시험용 경로: 마지막 버스를 가짜 서울시 정류장(08901 정릉시장)의 171번으로 바꿔 실시간 국민대행 버스가 붙게
const API_RESPONSE = JSON.parse(JSON.stringify(SAMPLE_ODSAY_RESPONSE));
Object.assign(API_RESPONSE.result.path[0].subPath[5], { startName: '정릉시장', startArsID: '08-901', lane: [{ busNo: '171', type: 11, busID: 1 }] });

async function serve(fn) {
  const clock = { t: kst('2026-11-16T07:00:00') }; // 월요일
  const nowMs = () => clock.t.getTime();
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet, clock: nowMs });
  const odsayFetch = fakeOdsayFetch({ respond: (u) => (u.searchParams.get('apiKey') === ODSAY_TEST_KEY ? API_RESPONSE : null) });
  const odsay = createOdsayService({ env: { ODSAY_API_KEY: ODSAY_TEST_KEY }, kv: createKv(), fetchImpl: odsayFetch, clock: nowMs, log: quiet });
  const subFetch = fakeSubwayFetch({ clock: nowMs });
  const subway = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: subFetch, clock: nowMs, log: quiet });
  const app = createApp({ store: createStore(null), provider, pusher: { enabled: false, publicKey: null }, now: () => clock.t, odsay, subway });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': 'u1' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(req, clock, { odsayFetch, subFetch }); } finally { srv.close(); provider.stop?.(); }
}

test('API: 경로 검색(직행 안내 포함) → 고른 경로 저장(서버 검색 결과에서 복사) → 내 정보 · 실시간 재료 · 오늘 추천 · 출발 방식 바꾸기 · health', async () => {
  await serve(async (req, clock, { odsayFetch, subFetch }) => {
    assert.equal((await req('PUT', '/api/me/timetable', { classes: [CLASS] })).status, 200);
    const s = (await req('POST', '/api/transit/search', { ...HONGDAE, arsId: '99201' })).body;
    assert.deepEqual([s.ok, s.paths.length, s.paths[0].title, s.calls.today, s.calls.cap], [true, 3, '2호선 → 4호선 → 171', 1, 25]);
    const near = (await req('POST', '/api/transit/search', { lat: 37.6085, lon: 127.0002, name: '청덕초등학교입구' })).body;
    assert.deepEqual([near.ok, near.fallback, near.reason], [false, 'direct', 'near']);
    assert.equal((await req('POST', '/api/me/transit', { searchId: 'n:없음:1,1', pathId: 'p0' })).status, 404);
    assert.equal((await req('POST', '/api/me/transit', {})).status, 400);
    const saved = (await req('POST', '/api/me/transit', { searchId: s.searchId, pathId: 'p0' })).body;
    assert.deepEqual([saved.transit.mode, saved.transit.route.title, saved.transit.origin.name], ['transit', '2호선 → 4호선 → 171', '홍대입구역']);
    const me = (await req('GET', '/api/me')).body;
    assert.deepEqual([me.transit.mode, me.transit.route.legs.length], ['transit', 7]);
    // 07:00: 지하철 실시간은 아직(출발 30분 전부터) · 마지막 171번은 서울시 실시간(국민대행)
    let live = (await req('GET', '/api/transit/live')).body;
    assert.deepEqual([live.first.source, live.final.source, live.final.arsId, live.final.trips.some((t) => t.no === '171')], ['skip', 'seoul', '08901', true]);
    assert.equal(subFetch.calls.length, 0, '출발 한참 전에는 지하철 실시간을 부르지 않음');
    live = (await req('GET', '/api/transit/live?force=1')).body;
    assert.deepEqual([live.first.source, live.first.kind, live.first.trains.map((x) => x.etaSec)], ['seoul', 'subway', [150, 420]]);
    const plan = (await req('GET', '/api/plan')).body;
    assert.deepEqual([plan.mode, plan.rec.mode, plan.rec.state, plan.transit.final.source], ['transit', 'transit', 'ok', 'seoul']);
    const bus = plan.rec.pick.legs.find((l) => l.kind === 'bus');
    assert.ok(['live', 'term'].includes(bus.src), '마지막 버스는 서울시 실시간(또는 그 배차간격)으로');
    assert.equal((await req('POST', '/api/me/transit', { mode: 'direct' })).body.transit.mode, 'direct');
    assert.equal((await req('GET', '/api/plan')).body.mode, 'direct');
    assert.equal((await req('GET', '/api/me')).body.transit.route.title, '2호선 → 4호선 → 171', '직행으로 바꿔도 고른 경로는 남음');
    const cleared = (await req('POST', '/api/me/transit', { clear: true })).body.transit;
    assert.deepEqual([cleared.mode, cleared.route, cleared.origin], ['direct', null, null], "'처음 상태로 되돌리기'는 고른 경로까지 지움");
    assert.equal((await req('GET', '/api/transit/live')).status, 404);
    const h = (await req('GET', '/api/health')).body;
    assert.deepEqual([h.odsay.keyConfigured, h.odsay.callsToday, h.odsay.cap, h.odsay.referer, h.seoulSubway.keyConfigured, h.seoulSubway.callsToday],
      [true, 1, 25, 'https://ku-bus-ai.onrender.com', true, 1]);
    assert.ok(h.odsay.lastShape.subPath.includes('trafficType') && h.odsay.lastShape.lane.includes('busNo'), '실제 응답 필드 이름 확인용(값 없음)');
    assert.ok(!JSON.stringify(h).includes(ODSAY_TEST_KEY) && !JSON.stringify(h).includes(SUBWAY_TEST_KEY));
    assert.equal(odsayFetch.calls.length, 1);
  });
});

test('서비스 없는 서버(키 없음): 검색은 직행 안내 · 저장 경로 없음 404 · health는 꺼짐으로', async () => {
  const app = createApp({ store: createStore(null), provider: createMockProvider('jeongneung'), pusher: { enabled: false, publicKey: null }, now: () => kst('2026-11-16T07:00:00') });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const s = await (await fetch(`${base}/api/transit/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(HONGDAE) })).json();
    assert.deepEqual([s.ok, s.fallback, s.reason], [false, 'direct', 'no-key']);
    assert.equal((await fetch(`${base}/api/transit/live`)).status, 404);
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual([h.odsay.keyConfigured, h.seoulSubway.keyConfigured], [false, false]);
  } finally { srv.close(); }
});

test('서버 출발 알림(환승 경로): 출발 30분 전부터 첫 지하철 실시간 · 출발 10분 전 알림 · 본문은 첫 탑승(2호선) · 도착을 기록하면 멈춤', async () => {
  const route = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0];
  const user = { classes: [CLASS], stop: null, prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {}, personal: { offsetMin: 0 }, arrivals: [], transit: { mode: 'transit', route } };
  const D = planTransit({ route, cls: CLASS, nowMin: 420, walkTable: WALK_TABLE }).pick.departMin; // 표준 계산 출발
  const at = kst(`2026-11-16T${toHHMM(D)}:00`); // 실시간 열차: 2분 30초 · 7분 뒤 → 7분 뒤 열차가 마지막으로 되는 열차
  const subway = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: fakeSubwayFetch({ clock: () => at.getTime() }), clock: () => at.getTime(), log: quiet });
  const r = await planFor(user, createMockProvider('jeongneung'), at, { windowMin: 180, subway });
  assert.deepEqual([r.mode, r.rec.mode, r.live.first.source, r.live.final.source], ['transit', 'transit', 'seoul', 'unavailable'], '마지막 버스 정류장(예시 번호)은 서울시에 없어 표준 대기 시간으로');
  assert.equal(r.rec.pick.legs.find((l) => l.kind === 'subway').src, 'live');
  assert.equal(r.alarms[0].type, 'depart');
  assert.match(r.alarms[0].body, /^2호선 \d{2}:\d{2} 탑승 · 강의실 \d{2}:\d{2} 도착 예정/);
  assert.equal(r.key, `2026-11-16:${CLASS.id}:transit`, '알림 기록은 직행과 따로(하루 중에 출발 방식을 바꿔도 섞이지 않게)');
  const mixed = await planFor({ ...user, fired: { [`2026-11-16:${CLASS.id}`]: { depart: { departMin: D + 30 } } } }, createMockProvider('jeongneung'), at, { windowMin: 180, subway });
  assert.deepEqual(mixed.alarms.map((a) => a.type), ['depart'], "직행 때 보낸 알림 기록이 있어도 '앞당겨졌어요'가 아니라 새 출발 알림");
  const done = await planFor({ ...user, arrivals: [{ key: `2026-11-16:${CLASS.id}` }] }, createMockProvider('jeongneung'), at, { windowMin: 180, subway });
  assert.deepEqual([done.arrived, done.alarms], [true, []]);
  const far = await planFor(user, createMockProvider('jeongneung'), kst('2026-11-16T05:00:00'), { windowMin: 180, subway });
  assert.deepEqual([far.live, far.alarms], [null, []], '수업 3시간 전보다 이르면 실시간 · 알림 없음');
});

test('메모리 저장소(kv): 만료 · 하루 카운터', async () => {
  let t = 0;
  const kv = createKv({ clock: () => t });
  await kv.set('a', 'x', 10);
  assert.equal(await kv.get('a'), 'x');
  t = 11_000;
  assert.equal(await kv.get('a'), null);
  assert.deepEqual([await kv.incr('c', 100), await kv.incr('c', 100), await kv.getNum('c')], [1, 2, 2]);
  await kv.hset('h', 'f', 'v');
  assert.deepEqual(await kv.hgetall('h'), { f: 'v' });
  await kv.hdel('h', 'f');
  assert.deepEqual(await kv.hgetall('h'), {});
});
