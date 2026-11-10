// v0.4: 탑승 정류장 하나 → 국민대행 노선(서울시 정류소정보·노선정보) — 캐시 · 직전 값 · 예시 데이터 폴백
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLiveService } from '../src/transit/index.js';
import { createMemoryCache } from '../src/transit/cache.js';
import { fakeSeoulFetch, expectedMinutes } from './fixtures/seoulFixture.js';

const MON_0810 = new Date('2026-11-08T23:10:00Z'); // 서울 월 08:10
const quiet = { warn() {}, info() {}, error() {} };
const gwQuota = readFileSync(new URL('./fixtures/gateway_quota.xml', import.meta.url), 'utf8');
const op = (u) => u.pathname.split('/').pop();
function service({ key = 'TESTKEY', fetchImpl = fakeSeoulFetch(), t0 = 1_000_000 } = {}) {
  const clock = { t: t0 };
  const svc = createLiveService({ env: { SEOUL_BUS_API_KEY: key }, fetchImpl, cache: createMemoryCache({ clock: () => clock.t }), clock: () => clock.t, background: false, log: quiet });
  return { svc, clock, fetchImpl };
}

test('정류장 하나 → 국민대로 가는 노선만(가까운 순), 하차 문·차내 시간·정체·원인, 출처 seoul', async () => {
  const { svc, fetchImpl } = service();
  const j = await svc.stopTrips('08901', MON_0810);
  assert.deepEqual([j.source, j.reason, j.stale], ['seoul', null, false]);
  assert.deepEqual(j.trips.map((t) => [t.no, t.gate, t.alightName]), [['1711', '정문', '국민대앞'], ['171', '정문', '국민대학교앞'], ['1112', '후문', '국민대후문']]);
  const [t1711, t171, t1112] = j.trips;
  // 공식 계산식 Σ(거리/속도) + 중간 정류장 × 20초 — 승차 seq 2 → 하차
  assert.ok(Math.abs(t171.inVehicleMin - expectedMinutes('900000171', 2, 6)) < 1e-9);
  assert.ok(Math.abs(t1711.inVehicleMin - expectedMinutes('900001711', 2, 5)) < 1e-9);
  assert.ok(Math.abs(t1112.inVehicleMin - expectedMinutes('900001112', 2, 5)) < 1e-9);
  assert.deepEqual([t171.cause, t171.congestion], ['정릉로', 'heavy']);
  assert.equal(t1112.cause, null);
  // 도착 예정: traTime(초) 우선, '곧 도착' 30초, 막차(둘째 운행종료)
  assert.deepEqual([t1711.etasSec, t171.etasSec, t1112.etasSec], [[30, 540], [180, 720], [370]]);
  assert.equal(svc.health().provider, 'seoul');
  // 7211번(국민대에 안 감)은 경유 정류소를 한 번만 확인
  assert.deepEqual(fetchImpl.calls.map(op).sort(), ['getStaionByRoute', 'getStaionByRoute', 'getStaionByRoute', 'getStaionByRoute', 'getStationByUid']);
});

test('캐시: 도착 정보 30초, 경유 정류소 5분, 국민대에 안 가는 노선은 다시 부르지 않음', async () => {
  const { svc, clock, fetchImpl } = service();
  await svc.stopTrips('08901', MON_0810);
  const n0 = fetchImpl.calls.length;
  clock.t += 20_000; await svc.stopTrips('08901', MON_0810);
  assert.equal(fetchImpl.calls.length, n0, '30초 안에는 호출 없음');
  clock.t += 11_000; await svc.stopTrips('08901', MON_0810);
  assert.deepEqual(fetchImpl.calls.slice(n0).map(op), ['getStationByUid']);
  const n1 = fetchImpl.calls.length;
  clock.t += 5 * 60_000; await svc.stopTrips('08901', MON_0810);
  assert.deepEqual(fetchImpl.calls.slice(n1).map(op).sort(), ['getStaionByRoute', 'getStaionByRoute', 'getStaionByRoute', 'getStationByUid']);
});

test('키가 없으면 서울시를 부르지 않고 예시 데이터(transitModel) + 이유 no-key', async () => {
  const { svc, fetchImpl } = service({ key: '' });
  const j = await svc.stopTrips('08901', MON_0810);
  assert.deepEqual([j.source, j.reason, j.reasonText], ['mock', 'no-key', 'API 키 없음']);
  assert.deepEqual(j.trips.map((t) => t.no).sort(), ['1112', '171', '1711']);
  assert.ok(j.trips.every((t) => t.example === true));
  assert.equal(fetchImpl.calls.length, 0);
  await assert.rejects(svc.searchStops('정릉'), (e) => e.kind === 'no-key');
});

test('호출 한도 초과: 직전 값(도착 예정은 흐른 만큼 줄임) → 3분 뒤 예시 데이터, 쿨다운 동안 호출 없음', async () => {
  let limited = false;
  const fetchImpl = fakeSeoulFetch({ fail: () => (limited ? { ok: true, status: 200, text: async () => gwQuota } : null) });
  const { svc, clock } = service({ fetchImpl });
  await svc.stopTrips('08901', MON_0810);
  limited = true; clock.t += 31_000;
  const stale = await svc.stopTrips('08901', MON_0810);
  assert.deepEqual([stale.source, stale.stale, stale.ageSec, stale.reason], ['seoul', true, 31, 'quota']);
  assert.deepEqual(stale.trips.find((t) => t.no === '171').etasSec, [149, 689]);
  assert.equal(svc.health().provider, 'mock');
  const n = fetchImpl.calls.length;
  clock.t += 3 * 60_000;
  const fb = await svc.stopTrips('08901', MON_0810);
  assert.deepEqual([fb.source, fb.reason], ['mock', 'quota']);
  assert.equal(fetchImpl.calls.length, n, '쿨다운 동안은 서울시 API를 부르지 않음');
  clock.t += 15 * 60_000; limited = false;
  assert.equal((await svc.stopTrips('08901', MON_0810)).source, 'seoul');
});

test('응답 해석 오류·네트워크 오류도 직전 값이 없으면 예시 데이터로, 결과 없는 정류장은 빈 목록(예시 아님)', async () => {
  const bad = fakeSeoulFetch({ fail: () => ({ ok: true, status: 200, text: async () => '<ServiceResult><msgHeader><headerCd>0' }) });
  const a = await service({ fetchImpl: bad }).svc.stopTrips('08901', MON_0810);
  assert.deepEqual([a.source, a.reason], ['mock', 'parse']);
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND ws.bus.go.kr'); };
  const b = await service({ fetchImpl: down }).svc.stopTrips('08901', MON_0810);
  assert.deepEqual([b.source, b.reason, b.reasonText], ['mock', 'network', '네트워크 오류']);
  const none = await service().svc.stopTrips('09999', MON_0810);  // headerCd 3: 정류소 없음
  assert.deepEqual([none.source, none.trips], ['seoul', []]);
});

test('정류장 검색: 이름(getStationByName) · 내 주변(getStationByPos, 가까운 순)', async () => {
  const { svc, fetchImpl } = service();
  assert.deepEqual((await svc.searchStops('정릉')).map((s) => [s.arsId, s.name]), [['08901', '정릉시장'], ['08911', '정릉시장'], ['08902', '정릉3동주민센터앞']]);
  const near = await svc.nearStops(37.6061, 127.0102);
  assert.deepEqual(near.map((s) => [s.arsId, s.distM]), [['08911', 35], ['08901', 120], ['08902', 260]]);
  const q = fetchImpl.calls.find((u) => op(u) === 'getStationByPos').searchParams;
  assert.deepEqual([q.get('tmX'), q.get('tmY'), q.get('radius')], ['127.0102000', '37.6061000', '400']);
  assert.deepEqual(await svc.searchStops('없는정류장'), []);
});
