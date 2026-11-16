// 서비스 워커(frontend/public/sw.js): 푸시를 받으면 알림을 띄우고 '받았음'(ack)을 서버에 알림 · 누르면 앱 열기 · 구독 바뀜 알림
// 브라우저 없이 Node vm으로 서비스 워커 전역(self · registration · clients · fetch)을 흉내 내 시험합니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../../frontend/public/sw.js', import.meta.url), 'utf8');

function loadWorker({ clients = [], subscription = { endpoint: 'https://web.push.apple.com/QDEVICE' } } = {}) {
  const handlers = {}, shown = [], fetched = [], opened = [];
  const reg = {
    showNotification: async (title, opt) => { shown.push({ title, opt }); },
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) }),
    },
  };
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {},
    registration: reg,
    location: { origin: 'https://ku-bus-ai.onrender.com' },
    clients: { claim: async () => {}, matchAll: async () => clients, openWindow: async (url) => { opened.push(url); } },
  };
  const fetchImpl = async (url, init) => { fetched.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return { json: async () => ({ enabled: true, publicKey: 'BPUB' }) }; };
  vm.runInNewContext(SRC, { self, fetch: fetchImpl, URL, atob: (s) => Buffer.from(s, 'base64').toString('binary'), Uint8Array, Promise, JSON, Boolean, String });
  const fire = async (type, ev) => {
    let waited = Promise.resolve();
    handlers[type]({ ...ev, waitUntil: (p) => { waited = p; } });
    await waited;
  };
  return { handlers, shown, fetched, opened, fire };
}
const pushEvent = (payload) => ({ data: { json: () => payload, text: () => String(payload) } });

test('푸시 받으면: 알림 띄우기 + 알림 번호(ack)와 이 기기 주소를 /api/push/ack로 보냄', async () => {
  const w = loadWorker();
  await w.fire('push', pushEvent({ title: 'KU BUS AI 테스트 알림', body: '이 알림이 보이면 성공이에요', tag: 'kubus-test', url: '/#settings', ack: 'ACK12345', kind: 'test' }));
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, 'KU BUS AI 테스트 알림');
  assert.deepEqual([w.shown[0].opt.body, w.shown[0].opt.tag, w.shown[0].opt.renotify, w.shown[0].opt.data.url], ['이 알림이 보이면 성공이에요', 'kubus-test', true, '/#settings']);
  assert.deepEqual(w.fetched, [{ url: '/api/push/ack', body: { id: 'ACK12345', endpoint: 'https://web.push.apple.com/QDEVICE' } }]);
});

test('번호가 없으면 ack를 보내지 않고, 태그가 없으면 renotify도 끔(크롬 오류 방지), 형식이 깨져도 알림은 띄움', async () => {
  const w = loadWorker({ subscription: null });
  await w.fire('push', pushEvent({ title: '출발', body: 'b' }));
  assert.deepEqual([w.shown[0].opt.tag, w.shown[0].opt.renotify, w.fetched.length], [undefined, false, 0]);
  await w.fire('push', { data: { json: () => { throw new Error('not json'); }, text: () => '그냥 글' } });
  assert.deepEqual([w.shown[1].title, w.shown[1].opt.body], ['KU BUS AI', '그냥 글']);
  await w.fire('push', pushEvent({ title: 't', ack: 'ACK99999' }));
  assert.deepEqual(w.fetched[0].body, { id: 'ACK99999', endpoint: null }, '구독을 못 읽어도 번호만으로 확인');
});

test('알림을 누르면: 열린 앱이 있으면 그 창으로(주소가 다르면 이동), 없으면 새로 열기', async () => {
  const none = loadWorker();
  await none.fire('notificationclick', { notification: { close() {}, data: { url: '/#settings' } } });
  assert.deepEqual(none.opened, ['https://ku-bus-ai.onrender.com/#settings']);
  const nav = [], focused = [];
  const open = loadWorker({ clients: [{ url: 'https://ku-bus-ai.onrender.com/#home', focus: async () => { focused.push(1); }, navigate: async (u) => { nav.push(u); } }] });
  await open.fire('notificationclick', { notification: { close() {}, data: { url: '/#settings' } } });
  assert.deepEqual([nav, focused.length, open.opened.length], [['https://ku-bus-ai.onrender.com/#settings'], 1, 0]);
});

test('구독이 바뀌면(pushsubscriptionchange) 예전 주소와 새 구독을 /api/push/rotate로', async () => {
  const w = loadWorker();
  await w.fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://push.example/old' }, newSubscription: { toJSON: () => ({ endpoint: 'https://push.example/new2', keys: { p256dh: 'p', auth: 'a' } }) } });
  assert.deepEqual(w.fetched, [{ url: '/api/push/rotate', body: { oldEndpoint: 'https://push.example/old', subscription: { endpoint: 'https://push.example/new2', keys: { p256dh: 'p', auth: 'a' } } } }]);
  const w2 = loadWorker();
  await w2.fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://push.example/old' } });
  assert.deepEqual(w2.fetched.map((f) => f.url), ['/api/push/key', '/api/push/rotate'], '새 구독이 없으면 서버 공개키로 다시 만듦');
});
