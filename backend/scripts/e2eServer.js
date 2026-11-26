// e2e 전용 서버: 가짜 서울시 API · 돌발정보 · 기상청 · Gemini · Upstash(테스트 고정 응답)를 넣은 서버(8801, VAPID 키 있음)와 키 없는 서버(8802)를 띄웁니다.
// 8801의 푸시는 실제 푸시 서버로 보내지 않고, 0.3초 뒤 '휴대폰 서비스 워커가 받았다'고 /api/push/ack를 대신 불러 수신 확인 흐름을 시험합니다.
// v2.0: 8801에 가짜 ODsay(하루 상한 3건으로 줄여 '한도 초과'까지) · 가짜 서울시 실시간 지하철. 8802는 키 없음
// v2.4.0: 8801에 가짜 경기도 버스 API(G1 확인 도구 /api/gyeonggi/test), 8802는 경기도 키 없음
// v2.5.0: 8801에 첫 버스가 경기도 정류장(가짜 수원역)인 저장 경로를 가진 e2e 사용자 둘(G2 경기도 첫 버스 실시간 · 출발 30분 전부터)
// v2.6.0: 8801에 07:40 '출발했어요!'를 누른 e2e 사용자 하나(예시 경로 2호선 → 4호선 → 171) — 서버 시계 08:10부터 4호선이 다음 탈 환승 지하철
// v2.7.0: 8801에 07:40 '출발했어요!'를 누른 e2e 사용자 둘(2호선 → 환승 버스 → 171) — 환승 버스가 가짜 서울시 정류장(08920 150) · 가짜 경기도 정류장(수원역 7770)
// v2.1: 두 서버 모두 '근처 국민대행 정류장 찾기'(nearKu) — 8801은 가짜 서울시 정류소정보(정릉시장 08901), 8802는 키 없음(지어내지 않음)
// 실행: node scripts/e2eServer.js   (frontend/dist가 먼저 빌드되어 있어야 함)
import webpush from 'web-push';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createUpstash, upstashUsers } from '../src/upstash.js';
import { UPSTASH_URL, fakeUpstashFetch } from '../test/fixtures/upstashFixture.js';
import { createLiveService } from '../src/transit/index.js';
import { createPusher } from '../src/push.js';
import { fakeSeoulFetch } from '../test/fixtures/seoulFixture.js';
import { fakeAccidentFetch } from '../test/fixtures/accidentFixture.js';
import { createAccidentService } from '../src/transit/seoulAccident.js';
import { fakeKmaFetch } from '../test/fixtures/kmaFixture.js';
import { createWeatherService } from '../src/transit/kmaWeather.js';
import { fakeGeminiFetch } from '../test/fixtures/geminiFixture.js';
import { createExplainService } from '../src/transit/geminiExplain.js';
import { SAMPLE_COURSES, SAMPLE_COURSE_META } from '../../shared/samples/sampleCourses.js';
import { SAMPLE_ODSAY_MIDBUS, SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult, routeKey } from '../../shared/transitPlan.js';
import { arrivalKey } from '../../shared/arrival.js';
import { seoulParts } from '../../shared/time.js';
import { createKv } from '../src/transit/kv.js';
import { createOdsayService } from '../src/transit/odsay.js';
import { createNearKuFinder } from '../src/transit/nearKu.js';
import { createCoordMigration } from '../src/coords.js';
import { createRetention } from '../src/retention.js';
import { createSubwayService } from '../src/transit/seoulSubway.js';
import { ODSAY_TEST_KEY, fakeOdsayFetch } from '../test/fixtures/odsayFixture.js';
import { SUBWAY_TEST_KEY, fakeSubwayFetch } from '../test/fixtures/subwayFixture.js';
import { createGyeonggiBusService } from '../src/transit/gyeonggiBus.js';
import { GG_TEST_KEY, fakeGyeonggiFetch } from '../test/fixtures/gyeonggiFixture.js';

const base = new Date('2026-11-08T23:10:00Z').getTime(), t0 = Date.now(); // 서울 월 08:10부터 흐르는 시계
const now = () => new Date(base + (Date.now() - t0));
const quiet = { warn() {}, info() {}, error() {} };
const vapid = webpush.generateVAPIDKeys();

const live = createLiveService({ env: { SEOUL_BUS_API_KEY: 'E2E-TEST-KEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet, kv: createKv({ clock: () => now().getTime() }) });
const courses = { meta: { ...SAMPLE_COURSE_META, available: true, count: SAMPLE_COURSES.length }, courses: SAMPLE_COURSES };
const incidents = createAccidentService({ env: { SEOUL_ACCIDENT_API_KEY: 'E2E-ACC-KEY' }, fetchImpl: fakeAccidentFetch(), clock: () => now().getTime() });
const weather = createWeatherService({ env: { KMA_API_KEY: 'E2E-KMA-KEY' }, fetchImpl: fakeKmaFetch(), clock: () => now().getTime() });
const explainer = createExplainService({ env: { GEMINI_API_KEY: 'E2E-GEMINI-KEY' }, fetchImpl: fakeGeminiFetch(), clock: () => now().getTime() });
const sentPushes = [];
const fakeDevice = async (s, body) => { // 가짜 휴대폰: 받으면 0.3초 뒤 '받았음'
  const payload = JSON.parse(body);
  sentPushes.push({ endpoint: s.endpoint, payload });
  if (payload.ack) setTimeout(() => fetch('http://localhost:8801/api/push/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: payload.ack, endpoint: s.endpoint }) }).catch(() => {}), 300);
  return { statusCode: 201 };
};
const upstash = upstashUsers(createUpstash({ url: UPSTASH_URL, token: 'UPSTASH-TEST-TOKEN', fetchImpl: fakeUpstashFetch() }));
const store8801 = createStore(null, { remote: upstash, log: quiet });
await store8801.ready;
// 가짜 ODsay 응답: 예시 경로의 마지막 버스를 가짜 서울시 정류장(08901 정릉시장)의 171번으로 → 국민대행 실시간이 붙음
const odsayResponse = JSON.parse(JSON.stringify(SAMPLE_ODSAY_RESPONSE));
Object.assign(odsayResponse.result.path[0].subPath[5], { startName: '정릉시장', startArsID: '08-901', lane: [{ busNo: '171', type: 11, busID: 1 }] });
const odsay = createOdsayService({
  env: { ODSAY_API_KEY: ODSAY_TEST_KEY, ODSAY_DAILY_CAP: '3' }, kv: createKv({ clock: () => now().getTime() }), clock: () => now().getTime(), log: quiet,
  fetchImpl: fakeOdsayFetch({ respond: (u) => (u.searchParams.get('apiKey') === ODSAY_TEST_KEY ? odsayResponse : null) }),
});
const subway = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: fakeSubwayFetch({ clock: () => now().getTime() }), clock: () => now().getTime(), log: quiet });
const nearKu = createNearKuFinder({ provider: live, clock: () => now().getTime() });
const gyeonggi = createGyeonggiBusService({ env: { GYEONGGI_BUS_API_KEY: GG_TEST_KEY }, fetchImpl: fakeGyeonggiFetch(), clock: () => now().getTime(), log: quiet });
// v2.5.0 첫 버스가 경기도 정류장인 저장 경로(e2e 사용자 둘에게 미리 넣어 둠 — 실서비스에서는 ODsay 검색 결과에서 고른 경로만 저장):
//   예시 경로의 첫 버스를 가짜 경기도 API의 수원역(03128) 7770으로, 마지막 버스를 가짜 서울시의 정릉시장(08901) 171로.
//   시간표는 e2e가 서버 시계에 맞춰 넣음(e2e-gg-live = 출발 30분 안 · e2e-gg-later = 출발 30분 전보다 이름). 예시 데이터
const ggResponse = JSON.parse(JSON.stringify(SAMPLE_ODSAY_RESPONSE));
Object.assign(ggResponse.result.path[1].subPath[1], { startName: '수원역', startX: 127.0003, startY: 37.2659, startArsID: '03-128', lane: [{ busNo: '7770', type: 4, busID: 1 }] });
Object.assign(ggResponse.result.path[1].subPath[5], { startName: '정릉시장', startArsID: '08-901', lane: [{ busNo: '171', type: 11, busID: 1 }] });
const ggRoute = parseOdsayResult(ggResponse).paths[1];
for (const id of ['e2e-gg-live', 'e2e-gg-later']) {
  store8801.update(id, (u) => { u.transit = { mode: 'transit', origin: { name: '수원역', kind: 'stop' }, route: ggRoute, savedAt: now().toISOString(), retry: null }; });
}
// v2.6.0 환승 지하철: 월 09:00 수업 · 예시 경로(2호선 → 4호선 → 171) · 07:40 출발 기록(실서비스에서는 [출발했어요!]로만 생김 — e2e라 미리 넣어 둠)
//   표준 계산: 2호선 07:48 탑승 → 08:06 내림 → 4호선(동대문역사문화공원) 08:12 도착 · 08:16 예정 탑승 → 08:01 ~ 08:31에 환승 지하철 실시간
const midRoute = parseOdsayResult(odsayResponse).paths[0];
const midClass = { id: 'e2eMid', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
store8801.update('e2e-mid', (u) => {
  u.classes = [midClass];
  u.transit = { mode: 'transit', origin: { name: '홍대입구역', kind: 'stop' }, route: midRoute, savedAt: now().toISOString(), retry: null };
  u.departure = { key: arrivalKey(seoulParts(now()).dateKey, midClass), at: new Date(now().getTime() - 30 * 60_000).toISOString(), departMin: 7 * 60 + 40, routeKey: routeKey(midRoute) };
});
// v2.7.0 환승 버스: 월 09:30 수업 · 예시 경로(2호선 → 환승 버스 → 171 정릉시장) · 07:40 출발 기록(e2e라 미리 넣어 둠)
//   표준 계산: 2호선 07:48 탑승 → 08:03 내림 → 환승 버스 정류장 08:10 도착 · 08:14 예정 탑승 → 07:59 ~ 08:29에 환승 버스 실시간
const midBusClass = { id: 'e2eMidBus', name: '운영체제', day: 0, start: '09:30', end: '10:45', building: '미래관', room: '302' };
const midBusRoute = (busLeg) => {
  const r = JSON.parse(JSON.stringify(SAMPLE_ODSAY_MIDBUS));
  Object.assign(r.result.path[0].subPath[3], busLeg);
  Object.assign(r.result.path[0].subPath[5], { startName: '정릉시장', startArsID: '08-901', lane: [{ busNo: '171', type: 11, busID: 1 }] });
  return parseOdsayResult(r).paths[0];
};
for (const [id, route] of [
  ['e2e-midbus', midBusRoute({ startArsID: '08-920' })], // 가짜 서울시 정류장 08920 시청앞.덕수궁 · 150
  ['e2e-midgg', midBusRoute({ startName: '수원역', startX: 127.0003, startY: 37.2659, startArsID: '03-128', lane: [{ busNo: '7770', type: 4, busID: 1 }] })], // 가짜 경기도 수원역 · 7770
]) {
  store8801.update(id, (u) => {
    u.classes = [midBusClass];
    u.transit = { mode: 'transit', origin: { name: '홍대입구역', kind: 'stop' }, route, savedAt: now().toISOString(), retry: null };
    u.departure = { key: arrivalKey(seoulParts(now()).dateKey, midBusClass), at: new Date(now().getTime() - 30 * 60_000).toISOString(), departMin: 7 * 60 + 40, routeKey: routeKey(route) };
  });
}
// v2.2.3 예전에 정밀하게 저장된 GPS 출발지 옮기기(실서비스처럼 켜질 때 한 번 — e2e 저장소는 비어 있어 옮길 것은 없음)
const coords = createCoordMigration({ store: store8801, odsay, clock: () => now().getTime(), log: quiet });
coords.start();
// v2.2.4 보관 기간(마지막 사용 후 90일 자동 삭제) — e2e 시계로는 90일이 지나지 않아 지워지는 사람은 없음
const retention = createRetention({ store: store8801, env: {}, clock: () => now().getTime(), log: quiet });
retention.start();
createApp({ store: store8801, provider: live, now, courses, incidents, weather, explainer, odsay, subway, gyeonggi, nearKu, coords, retention, pusher: createPusher({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }, quiet, { sendImpl: fakeDevice }) })
  .listen(8801, () => console.log('fixture seoul server 8801'));
const nokey = createLiveService({ env: {}, background: false, log: quiet });
createApp({ store: createStore(null), provider: nokey, now, pusher: createPusher({}, quiet), nearKu: createNearKuFinder({ provider: nokey, clock: () => now().getTime() }), incidents: createAccidentService({ env: {}, clock: () => now().getTime() }), weather: createWeatherService({ env: {}, clock: () => now().getTime() }), explainer: createExplainService({ env: {}, clock: () => now().getTime() }) })
  .listen(8802, () => console.log('no-key server 8802'));
