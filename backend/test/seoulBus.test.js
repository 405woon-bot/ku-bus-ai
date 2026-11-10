import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeoulResponse, SeoulApiError } from '../src/transit/seoulResponse.js';
import { createSeoulAdapter, createSeoulClient, inVehicleMinutes, parseArrival, parseArrmsg, parseStations, sectionConvention } from '../src/transit/seoulBus.js';
import { createMemoryCache, createRedisCache } from '../src/transit/cache.js';
import { ARRIVALS, USER_ROUTES, expectedMinutes, fakeSeoulFetch, json, xml } from './fixtures/seoulFixture.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const KEY = '0ed3TESTKEY+/=abc';
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);

/* ── 응답 해석(XML·JSON) ── */
test('활용가이드 예제 XML(getStaionByRoute) 해석: 값은 문자열, 첫 정류장 구간값 0', () => {
  const r = parseSeoulResponse(fx('guide_getStaionByRoute.xml'));
  assert.equal(r.format, 'xml');
  assert.equal(r.code, '0');
  assert.equal(r.items.length, 2);
  assert.equal(r.items[1].stationNm, '북가좌2동주민센터');
  assert.equal(r.items[1].fullSectDist, '249');
  assert.equal(r.items[1].sectSpd, '12');
  const st = parseStations(r.items);
  assert.deepEqual(st.map((s) => [s.seq, s.arsId, s.sectDistM, s.sectSpdKmh]), [[1, '13285', 0, 0], [2, '13175', 249, 12]]);
  assert.equal(sectionConvention(st), 'arrival');
});

test('JSON 응답도 같은 결과, 항목 하나짜리·특수문자·빈 요소 처리', () => {
  const items = [{ stationNm: 'A&B <정류장>', seq: '1', gpsX: '' }];
  const a = parseSeoulResponse(xml(items)), b = parseSeoulResponse(json(items));
  assert.equal(a.format, 'xml'); assert.equal(b.format, 'json');
  assert.deepEqual(a.items, b.items);
  assert.equal(a.items[0].stationNm, 'A&B <정류장>');
  assert.equal(a.items[0].gpsX, '');
  assert.deepEqual(parseSeoulResponse('<ServiceResult><msgHeader><headerCd>0</headerCd></msgHeader><msgBody><itemList><seq/></itemList></msgBody></ServiceResult>').items, [{ seq: '' }]);
});

test('결과 코드: 4(노선 없음)·8(운행 종료)은 빈 목록, 6은 일시 오류, 1·2는 API 오류', () => {
  assert.deepEqual(parseSeoulResponse(xml([{ a: '1' }], { code: '4', msg: '노선을 찾을 수 없습니다.' })).items, []);
  assert.equal(parseSeoulResponse(xml([], { code: '8', msg: '운행 종료되었습니다.' })).code, '8');
  assert.throws(() => parseSeoulResponse(xml([], { code: '6', msg: '실시간 정보를 읽을 수 없습니다' })), (e) => e.kind === 'temporary');
  assert.throws(() => parseSeoulResponse(xml([], { code: '2', msg: '잘못된 쿼리' })), (e) => e.kind === 'api');
});

test('호출 한도·인증 오류(포털 게이트웨이 형식)와 깨진 응답 구분', () => {
  assert.throws(() => parseSeoulResponse(fx('gateway_quota.xml')), (e) => e instanceof SeoulApiError && e.kind === 'quota');
  assert.throws(() => parseSeoulResponse(fx('gateway_key.xml')), (e) => e.kind === 'auth');
  assert.throws(() => parseSeoulResponse('<ServiceResult><msgHeader><headerCd>0</head'), (e) => e.kind === 'parse');
  assert.throws(() => parseSeoulResponse('<html><body>502 Bad Gateway</body></html>'), (e) => e.kind === 'parse');
  assert.throws(() => parseSeoulResponse('{"msgHeader":'), (e) => e.kind === 'parse');
  assert.throws(() => parseSeoulResponse(''), (e) => e.kind === 'parse');
  assert.throws(() => parseSeoulResponse('LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR'), (e) => e.kind === 'quota');
});

/* ── 소요시간·정체 원인 ── */
test('차내 소요시간 = Σ 구간거리/구간속도 + 중간 정류장 × 20초 (v0.1 기준값 유지)', () => {
  const st = parseStations([
    { seq: '1', station: '100', arsId: '08001', stationNm: '내 승차 정류장', fullSectDist: '0', sectSpd: '0' },
    { seq: '2', station: '101', arsId: '08002', stationNm: '중간1', fullSectDist: '600', sectSpd: '24' },
    { seq: '3', station: '102', arsId: '08003', stationNm: '중간2', fullSectDist: '500', sectSpd: '6' },
    { seq: '4', station: '103', arsId: '08004', stationNm: '국민대학교앞', fullSectDist: '400', sectSpd: '20' },
  ]);
  const t = inVehicleMinutes(st, 1, 4);
  // 600/400 + 500/100 + 400/333.3 = 1.5 + 5 + 1.2 = 7.7분, 중간 정류장 2곳 × 20초 = 0.67분
  near(t.minutes, 8.3667, 0.001);
  assert.equal(t.intermediateStops, 2);
  assert.equal(t.slowest.to, '중간2');
  assert.equal(t.slowest.kmh, 6);
  assert.throws(() => inVehicleMinutes(st, 4, 1), (e) => e.kind === 'config');
});

test('구간속도 0·비정상은 15 km/h로 계산하고 정체 판단에서 제외, 반대 저장 방식(마지막 행 0)도 처리', () => {
  const st = parseStations([
    { seq: '1', stationNm: 'A', arsId: '1', fullSectDist: '300', sectSpd: '0' },
    { seq: '2', stationNm: 'B', arsId: '2', fullSectDist: '500', sectSpd: '10' },
    { seq: '3', stationNm: 'C', arsId: '3', fullSectDist: '0', sectSpd: '0' },
  ]);
  assert.equal(sectionConvention(st), 'departure');
  const t = inVehicleMinutes(st, 1, 3);
  near(t.minutes, 300 / 250 + 500 / (10000 / 60) + 20 / 60, 1e-9);
  assert.equal(t.slowest.from, 'B');
});

test('도착 메시지·도착정보 해석(traTime 초 우선, 없으면 arrmsg)', () => {
  assert.equal(parseArrmsg('3분12초후[2번째 전]'), 192);
  assert.equal(parseArrmsg('2분후[2번째 전]'), 120);
  assert.equal(parseArrmsg('곧 도착'), 30);
  assert.equal(parseArrmsg('운행종료'), null);
  assert.equal(parseArrmsg('출발대기'), null);
  const a = parseArrival(ARRIVALS['08901'], { busRouteId: '900000171', no: '171' });
  assert.deepEqual([a.staOrd, a.termMin, a.first.sec, a.first.msg, a.second.sec, a.first.congestion], [2, 8, 180, '3분후[1번째 전]', 720, '보통']);
  const b = parseArrival(ARRIVALS['08901'], { busRouteId: 'x', no: '1112' });
  assert.equal(b.first.sec, 370); assert.equal(b.second.sec, null);
  assert.equal(parseArrival(ARRIVALS['08901'], { busRouteId: 'x', no: '999' }), null);
});

for (const format of ['xml', 'json']) {
  test(`어댑터(${format}): 노선ID → 정류장 → 도착정보 → liveMin·정체 원인`, async () => {
    const fetchImpl = fakeSeoulFetch({ format });
    const client = createSeoulClient({ key: KEY, fetchImpl, format });
    const ad = createSeoulAdapter({ client, cache: createMemoryCache() });
    const r171 = await ad.routeLive(USER_ROUTES[0]);
    assert.equal(r171.busRouteId, '900000171');
    assert.deepEqual([r171.board.seq, r171.alight.seq, r171.alight.name], [2, 6, '국민대학교앞']);
    near(r171.trip.minutes, expectedMinutes('900000171', 2, 6), 1e-9);
    assert.equal(Math.round(r171.trip.minutes), 18);
    assert.equal(r171.trip.intermediateStops, 3);
    assert.deepEqual(r171.cause, { text: '정릉로', road: '정릉로', from: '고려대사범대학부속고등학교', to: '청덕초등학교입구', kmh: 4 });
    assert.equal(r171.arrival.first.sec, 180);
    const r1711 = await ad.routeLive(USER_ROUTES[1]);
    assert.equal(Math.round(r1711.trip.minutes), 12);
    assert.equal(r1711.cause.text, '정릉3동주민센터앞→청덕초등학교입구 구간'); // 매핑표에 없는 구간은 정류장 이름으로
    const r1112 = await ad.routeLive(USER_ROUTES[2]);
    assert.equal(Math.round(r1112.trip.minutes), 7);
    assert.equal(r1112.cause, null); // 15 km/h 이상이면 정체 아님
    // 호출: 노선목록 3 + 정류장 3 + 도착정보 1(같은 정류장이라 캐시)
    const paths = fetchImpl.calls.map((u) => u.pathname.split('/').pop());
    assert.deepEqual([paths.filter((p) => p === 'getBusRouteList').length, paths.filter((p) => p === 'getStaionByRoute').length, paths.filter((p) => p === 'getStationByUid').length], [3, 3, 1]);
    const u = fetchImpl.calls[0];
    assert.equal(u.origin + u.pathname, 'http://ws.bus.go.kr/api/rest/busRouteInfo/getBusRouteList');
    assert.equal(u.searchParams.get('ServiceKey'), KEY);
    assert.equal(u.searchParams.get('resultType'), format === 'json' ? 'json' : null);
  });
}

test('정류장 설정 오류: 번호 없음 · 노선에 없는 정류장 · 하차 정류장 없음 · 없는 노선', async () => {
  const ad = createSeoulAdapter({ client: createSeoulClient({ key: KEY, fetchImpl: fakeSeoulFetch() }), cache: createMemoryCache() });
  const r = USER_ROUTES[0];
  await assert.rejects(ad.routeLive({ ...r, boardArsId: '' }), (e) => e.kind === 'config' && /5자리/.test(e.message));
  await assert.rejects(ad.routeLive({ ...r, boardArsId: '09999' }), (e) => e.kind === 'config' && /09999/.test(e.message));
  await assert.rejects(ad.routeLive({ ...r, alightName: '없는정류장' }), (e) => e.kind === 'config' && /없는정류장/.test(e.message));
  await assert.rejects(ad.routeLive({ ...r, no: '9999' }), (e) => e.kind === 'config' && /9999번/.test(e.message));
  // 같은 이름이 왕복에 두 번(seq 6, 9) — 승차 뒤 첫 번째(seq 6)를 하차로
  const ok = await ad.routeLive({ ...r, boardArsId: '08902' });
  assert.deepEqual([ok.board.seq, ok.alight.seq], [3, 6]);
});

test('HTTP 클라이언트 오류 분류와 키 가리기', async () => {
  const mk = (fetchImpl, o = {}) => createSeoulClient({ key: KEY, fetchImpl, timeoutMs: 50, ...o });
  await assert.rejects(createSeoulClient({ key: '' }).call('x'), (e) => e.kind === 'no-key');
  await assert.rejects(mk(async (url) => { throw new Error(`ECONNREFUSED ${url}`); }).call('x'), (e) => e.kind === 'network' && !e.message.includes(KEY) && !e.message.includes(encodeURIComponent(KEY)));
  await assert.rejects(mk((_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))).call('x'), (e) => e.kind === 'timeout');
  await assert.rejects(mk(async () => ({ ok: false, status: 429, text: async () => '' })).call('x'), (e) => e.kind === 'quota');
  await assert.rejects(mk(async () => ({ ok: false, status: 500, text: async () => fx('gateway_key.xml') })).call('x'), (e) => e.kind === 'auth');
  await assert.rejects(mk(async () => ({ ok: false, status: 503, text: async () => 'down' })).call('x'), (e) => e.kind === 'http');
  await assert.rejects(mk(async () => ({ ok: true, status: 200, text: async () => fx('gateway_quota.xml') })).call('x'), (e) => e.kind === 'quota');
  // Encoding 키(%포함)는 다시 인코딩하지 않음, 파라미터 이름 바꾸기
  let seen;
  await mk(async (url) => { seen = url; return { ok: true, status: 200, text: async () => xml([]) }; }, { key: 'abc%2Bdef', keyParam: 'serviceKey' }).call('p', { a: '1' });
  assert.match(seen, /\?serviceKey=abc%2Bdef&a=1$/);
});

test('캐시: 메모리 TTL 만료, Redis 어댑터(가짜 클라이언트)', async () => {
  let t = 0;
  const m = createMemoryCache({ clock: () => t });
  await m.set('k', { a: 1 }, 30_000);
  assert.deepEqual((await m.get('k')).value, { a: 1 });
  t = 30_001;
  assert.equal(await m.get('k'), null);
  const store = new Map();
  const fake = { get: async (k) => store.get(k) ?? null, set: async (k, v, o) => { store.set(k, v); store.set(`${k}:px`, o.PX); } };
  const r = createRedisCache(fake);
  await r.set('stations:1', [1, 2], 30_000);
  assert.deepEqual((await r.get('stations:1')).value, [1, 2]);
  assert.equal(store.get('kubusai:stations:1:px'), 30_000);
});
