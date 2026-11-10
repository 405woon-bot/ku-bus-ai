// e2e 전용 서버: 가짜 서울시 API(테스트 고정 응답)를 넣은 서버(8801, VAPID 키 있음)와 키 없는 서버(8802)를 띄웁니다.
// 실행: node scripts/e2eServer.js   (frontend/dist가 먼저 빌드되어 있어야 함)
import webpush from 'web-push';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService } from '../src/transit/index.js';
import { createPusher } from '../src/push.js';
import { fakeSeoulFetch } from '../test/fixtures/seoulFixture.js';

const base = new Date('2026-11-08T23:10:00Z').getTime(), t0 = Date.now(); // 서울 월 08:10부터 흐르는 시계
const now = () => new Date(base + (Date.now() - t0));
const quiet = { warn() {}, info() {}, error() {} };
const vapid = webpush.generateVAPIDKeys();

const live = createLiveService({ env: { SEOUL_BUS_API_KEY: 'E2E-TEST-KEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet });
createApp({ store: createStore(null), provider: live, now, pusher: createPusher({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }, quiet) })
  .listen(8801, () => console.log('fixture seoul server 8801'));
const nokey = createLiveService({ env: {}, background: false, log: quiet });
createApp({ store: createStore(null), provider: nokey, now, pusher: createPusher({}, quiet) })
  .listen(8802, () => console.log('no-key server 8802'));
