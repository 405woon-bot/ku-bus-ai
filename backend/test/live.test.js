import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBaseline, createLiveService } from '../src/transit/index.js';
import { createMemoryCache } from '../src/transit/cache.js';
import { USER_ROUTES, fakeSeoulFetch } from './fixtures/seoulFixture.js';

const MON_0810 = new Date('2026-11-08T23:10:00Z'); // 서울 월 08:10
const quiet = { warn() {}, info() {}, error() {} };
const gw = readFileSync(new URL('./fixtures/gateway_quota.xml', import.meta.url), 'utf8');
function service({ key = 'TESTKEY', fetchImpl = fakeSeoulFetch(), t0 = 1_000_000, ...o } = {}) {
  const clock = { t: t0 };
  const cache = createMemoryCache({ clock: () => clock.t });
  const svc = createLiveService({ env: { SEOUL_BUS_API_KEY: key }, fetchImpl, cache, clock: () => clock.t, background: false, log: quiet, ...o });
  return { svc, clock, fetchImpl };
}

test('서울시 응답으로 노선별 liveMin·usualMin·delayMin·status·cause, 출처 seoul', async () => {
  const { svc } = service();
  const j = await svc.live(USER_ROUTES, MON_0810);
  assert.equal(j.provider, 'seoul');
  assert.equal(j.source, 'seoul');
  assert.deepEqual(j.routes.map((r) => [r.no, r.liveMin, r.usualMin, r.delayMin, r.status.label, r.cause, r.source]), [
    ['171', 18, 12, 6, '+6분 지연', '정릉로', 'seoul'],
    ['1711', 12, 14, 0, '원활', '정릉3동주민센터앞→청덕초등학교입구 구간', 'seoul'],
    ['1112', 7, 13, 0, '원활', null, 'seoul'],
  ]);
  assert.equal(j.cause, '정릉로');                   // 가장 많이 늦는 노선의 원인
  assert.deepEqual(j.roadDelays, { 정릉로: 6 });      // 정체 지도용
  assert.equal(j.routes[0].arrival.first.msg, '3분후[1번째 전]');
  assert.deepEqual(j.routes[0].inVehicle.slowest, { from: '고려대사범대학부속고등학교', to: '청덕초등학교입구', kmh: 4 });
  assert.equal(svc.health().provider, 'seoul');
});

test('30초 캐시: 30초 안의 재요청은 서울시를 다시 부르지 않고, 지나면 새로 부름', async () => {
  const { svc, clock, fetchImpl } = service();
  await svc.live(USER_ROUTES, MON_0810);
  const n = fetchImpl.calls.length;
  clock.t += 20_000;
  await svc.live(USER_ROUTES, MON_0810);
  assert.equal(fetchImpl.calls.length, n);
  clock.t += 11_000;
  await svc.live(USER_ROUTES, MON_0810);
  const after = fetchImpl.calls.slice(n).map((u) => u.pathname.split('/').pop());
  assert.deepEqual(after.sort(), ['getStaionByRoute', 'getStaionByRoute', 'getStaionByRoute', 'getStationByUid']); // 노선ID는 12시간 캐시
});

test('백그라운드 갱신: 최근 요청된 노선을 미리 불러 캐시를 채움', async () => {
  const { svc, clock, fetchImpl } = service();
  await svc.live(USER_ROUTES.slice(0, 1), MON_0810);
  const n = fetchImpl.calls.length;
  clock.t += 31_000;
  await svc.refreshActive();
  assert.ok(fetchImpl.calls.length > n);
  const m = fetchImpl.calls.length;
  await svc.live(USER_ROUTES.slice(0, 1), MON_0810); // 캐시에서 바로
  assert.equal(fetchImpl.calls.length, m);
});

test('키가 없으면 예시(모의) 데이터로 폴백, 이유 no-key', async () => {
  const { svc, fetchImpl } = service({ key: '' });
  const j = await svc.live(USER_ROUTES, MON_0810);
  assert.equal(j.provider, 'mock');
  assert.equal(j.reason, 'no-key');
  assert.equal(j.reasonText, 'API 키 없음');
  assert.ok(j.routes.every((r) => r.source === 'mock' && Number.isFinite(r.liveMin) && r.status));
  assert.equal(j.routes[0].liveMin, 20); // transitModel 정릉로 시나리오 08:10
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual([svc.health().provider, svc.health().reason], ['mock', 'no-key']);
});

test('호출 한도 초과: 직전 정상값(3분 이내) → 그 뒤 모의 데이터, 쿨다운 동안 호출 중단', async () => {
  let limited = false;
  const fetchImpl = fakeSeoulFetch({ fail: () => (limited ? { ok: true, status: 200, text: async () => gw } : null) });
  const { svc, clock } = service({ fetchImpl });
  await svc.live(USER_ROUTES, MON_0810);
  limited = true;
  clock.t += 31_000;
  const stale = await svc.live(USER_ROUTES, MON_0810);
  assert.equal(stale.provider, 'seoul');
  assert.ok(stale.routes.every((r) => r.stale === true && r.ageSec === 31));
  assert.equal(svc.health().provider, 'mock'); // 쿨다운 중
  const n = fetchImpl.calls.length;
  clock.t += 3 * 60_000;
  const fb = await svc.live(USER_ROUTES, MON_0810);
  assert.equal(fb.provider, 'mock');
  assert.equal(fb.reason, 'quota');
  assert.equal(fetchImpl.calls.length, n, '쿨다운 동안은 서울시 API를 부르지 않음');
  clock.t += 15 * 60_000; limited = false;
  assert.equal((await svc.live(USER_ROUTES, MON_0810)).provider, 'seoul');
});

test('응답 해석 오류·네트워크 오류도 정상값이 없으면 모의 데이터로', async () => {
  const bad = fakeSeoulFetch({ fail: () => ({ ok: true, status: 200, text: async () => '<ServiceResult><msgHeader><headerCd>0' }) });
  const a = await service({ fetchImpl: bad }).svc.live(USER_ROUTES, MON_0810);
  assert.deepEqual([a.provider, a.reason], ['mock', 'parse']);
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND ws.bus.go.kr'); };
  const b = await service({ fetchImpl: down }).svc.live(USER_ROUTES, MON_0810);
  assert.deepEqual([b.provider, b.reason, b.reasonText], ['mock', 'network', '네트워크 오류']);
});

test('일부 노선만 실패하면 예시 값을 섞지 않고 그 노선은 정보 없음(liveMin null)', async () => {
  const routes = [USER_ROUTES[0], { ...USER_ROUTES[2], boardArsId: '' }];
  const j = await service().svc.live(routes, MON_0810);
  assert.equal(j.provider, 'seoul');
  assert.equal(j.partial, true);
  assert.equal(j.routes[1].liveMin, null);
  assert.equal(j.routes[1].errorKind, 'config');
  // 승차 정류장을 하나도 안 넣었으면 → 예시 데이터 + 이유 '승차 정류장 미설정'
  const none = await service().svc.live(USER_ROUTES.map((r) => ({ ...r, boardArsId: '' })), MON_0810);
  assert.deepEqual([none.provider, none.reasonText], ['mock', '승차 정류장 미설정']);
});

test('평소 소요시간: 같은 요일·15분 칸 기록이 쌓이면 사용자가 넣은 값 대신 기록값', async () => {
  const baseline = createBaseline();
  const { svc } = service({ baseline });
  const day1 = await svc.live(USER_ROUTES.slice(0, 1), MON_0810);
  assert.equal(day1.routes[0].usualMin, 12);              // 첫날: 사용자 값
  const nextMon = new Date(MON_0810.getTime() + 7 * 86400e3);
  const day2 = await service({ baseline }).svc.live(USER_ROUTES.slice(0, 1), nextMon);
  assert.equal(day2.routes[0].usualMin, 18);              // 지난주 같은 시간대 기록
  assert.equal(day2.routes[0].delayMin, 0);
});

test('평소 소요시간은 같은 날 다시 물어도 오늘 값이 섞이지 않음(지연이 사라지지 않음)', async () => {
  const { svc } = service();
  const a = await svc.live(USER_ROUTES.slice(0, 1), MON_0810);
  const b = await svc.live(USER_ROUTES.slice(0, 1), new Date(MON_0810.getTime() + 60_000));
  assert.deepEqual([a.routes[0].usualMin, a.routes[0].delayMin], [12, 6]);
  assert.deepEqual([b.routes[0].usualMin, b.routes[0].delayMin], [12, 6]);
});
