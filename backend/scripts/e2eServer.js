// e2e 전용 서버: 가짜 서울시 API · 돌발정보 · 기상청 · Gemini · Upstash(테스트 고정 응답)를 넣은 서버(8801, VAPID 키 있음)와 키 없는 서버(8802)를 띄웁니다.
// 8801의 푸시는 실제 푸시 서버로 보내지 않고, 0.3초 뒤 '휴대폰 서비스 워커가 받았다'고 /api/push/ack를 대신 불러 수신 확인 흐름을 시험합니다.
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

const base = new Date('2026-11-08T23:10:00Z').getTime(), t0 = Date.now(); // 서울 월 08:10부터 흐르는 시계
const now = () => new Date(base + (Date.now() - t0));
const quiet = { warn() {}, info() {}, error() {} };
const vapid = webpush.generateVAPIDKeys();

const live = createLiveService({ env: { SEOUL_BUS_API_KEY: 'E2E-TEST-KEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet });
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
createApp({ store: store8801, provider: live, now, courses, incidents, weather, explainer, pusher: createPusher({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }, quiet, { sendImpl: fakeDevice }) })
  .listen(8801, () => console.log('fixture seoul server 8801'));
const nokey = createLiveService({ env: {}, background: false, log: quiet });
createApp({ store: createStore(null), provider: nokey, now, pusher: createPusher({}, quiet), incidents: createAccidentService({ env: {}, clock: () => now().getTime() }), weather: createWeatherService({ env: {}, clock: () => now().getTime() }), explainer: createExplainService({ env: {}, clock: () => now().getTime() }) })
  .listen(8802, () => console.log('no-key server 8802'));
