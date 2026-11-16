// 백그라운드 알림(Web Push): VAPID 설정 오류에도 서버는 멈추지 않음 · 구독(자동 재등록) · 테스트 알림 · 수신 확인(ack) · 만료 구독 정리
// · 홈 화면 앱 이어받기 코드 · 서버 깨우기(/api/wake) · 스케줄러 출발 알림 기록. 실제 푸시 서버에는 보내지 않습니다(sendImpl 가짜).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createMockProvider } from '../src/transit/index.js';
import { createPusher, deviceId, pushSummary, upsertSubscription, validSubscription } from '../src/push.js';
import { createScheduler } from '../src/scheduler.js';

const quiet = { warn() {}, info() {}, error() {} };
const sub = (n = 1) => ({ endpoint: `https://web.push.apple.com/QEXAMPLE${n}`, keys: { p256dh: `BPfake${n}`, auth: `auth${n}` }, expirationTime: null });
const VAPID = webpush.generateVAPIDKeys();

/** 가짜 발송: 보낸 것을 남기고, status(endpoint)로 응답 코드를 정함 */
function fakeSend(statusOf = () => 201) {
  const sent = [];
  const fn = async (s, body, opt) => {
    sent.push({ endpoint: s.endpoint, payload: JSON.parse(body), opt });
    const status = statusOf(s.endpoint);
    if (status >= 400) throw Object.assign(new Error(`Received unexpected response code ${status}`), { statusCode: status, body: 'gone' });
    return { statusCode: status };
  };
  fn.sent = sent;
  return fn;
}

test('VAPID: 키가 없으면 꺼짐 · 형식이 틀려도 서버는 멈추지 않고 이유를 남김 · 맞는 키면 켜짐', async () => {
  const off = createPusher({}, quiet);
  assert.deepEqual([off.enabled, off.publicKey, off.configError], [false, null, null]);
  assert.deepEqual((await off.deliver([sub()], { title: 't' })).results.map((r) => [r.ok, r.skipped]), [[false, true]]);
  const bad = createPusher({ VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'admin@example.com' }, quiet);
  assert.equal(bad.enabled, false);
  assert.match(bad.configError, /VAPID_SUBJECT/);
  assert.ok(!bad.configError.includes(VAPID.privateKey));
  const badKey = createPusher({ VAPID_PUBLIC_KEY: 'short', VAPID_PRIVATE_KEY: 'short', VAPID_SUBJECT: 'mailto:me@example.com' }, quiet);
  assert.equal(badKey.enabled, false);
  const ok = createPusher({ VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'mailto:me@example.com' }, quiet);
  assert.deepEqual([ok.enabled, ok.publicKey, ok.configError], [true, VAPID.publicKey, null]);
});

test('발송 결과: 성공 · 만료(404/410 → 지울 것) · 그 밖의 실패, TTL · urgency', async () => {
  const send = fakeSend((ep) => (ep.endsWith('2') ? 410 : ep.endsWith('3') ? 500 : 201));
  const p = createPusher({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }, quiet, { sendImpl: send });
  const { results } = await p.deliver([sub(1), sub(2), sub(3)], { title: '출발', body: 'b' }, { ttl: 120 });
  assert.deepEqual(results.map((r) => [r.ok, r.status, r.gone]), [[true, 201, false], [false, 410, true], [false, 500, false]]);
  assert.deepEqual(send.sent[0].opt, { TTL: 120, urgency: 'high' });
  assert.deepEqual(send.sent[0].payload, { title: '출발', body: 'b' });
  assert.deepEqual(await p.send([sub(1), sub(2)], { title: 'x' }), [sub(2).endpoint], '예전 방식: 만료된 것만');
});

test('구독 기록: 같은 주소면 갱신(이미 앎) · 새 주소면 추가 · 최대 5개 · 요약에는 주소 · 키가 없음', () => {
  assert.equal(validSubscription(sub()), true);
  assert.equal(validSubscription({ endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } }), false, 'https만');
  assert.equal(validSubscription({ endpoint: 'https://x' }), false);
  const u = { push: [], pushLog: [] };
  assert.equal(upsertSubscription(u, sub(1), { device: 'iPhone', standalone: true, now: 1000 }).known, false);
  u.push[0].ackAt = 1500;
  const again = upsertSubscription(u, sub(1), { now: 2000 });
  assert.deepEqual([again.known, again.rec.addedAt, again.rec.seenAt, again.rec.ackAt, again.rec.device, again.rec.standalone], [true, 1000, 2000, 1500, 'iPhone', true]);
  for (let i = 2; i <= 7; i++) upsertSubscription(u, sub(i), { now: 3000 + i });
  assert.equal(u.push.length, 5);
  const sum = pushSummary(u, sub(7).endpoint);
  assert.equal(sum.device.id, deviceId(sub(7).endpoint));
  assert.equal(sum.device.id.length, 10);
  assert.ok(!JSON.stringify(sum).includes('web.push.apple.com') && !JSON.stringify(sum).includes('BPfake'));
});

function harness({ vapid = true, statusOf, ready } = {}) {
  const clock = { t: Date.parse('2026-11-17T08:00:00Z') };
  const now = () => new Date(clock.t);
  const store = createStore(null, { clock: () => clock.t });
  if (ready) store.ready = ready;
  const send = fakeSend(statusOf);
  const pusher = vapid ? createPusher({ VAPID_PUBLIC_KEY: 'BPUB', VAPID_PRIVATE_KEY: 'PRIV' }, quiet, { sendImpl: send }) : createPusher({}, quiet);
  const scheduler = { status: () => ({ lastTickAt: '2026-11-17T07:59:00.000Z' }) };
  const app = createApp({ store, provider: createMockProvider(), pusher, now, scheduler, courses: { meta: { available: false }, courses: [] } });
  return { app, store, send, clock };
}
async function serve(h, fn) {
  const srv = h.app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, uid = 'u1') => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': uid }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json()) };
  };
  try { await fn(call); } finally { srv.close(); }
}

test('/api/push: 구독(앱을 열 때마다 · 이미 알면 known) → 테스트 알림(이 기기로) → 서비스 워커 ack → 수신 확인됨', async () => {
  const h = harness();
  await serve(h, async (call) => {
    assert.deepEqual((await call('GET', '/api/push/key')), { status: 200, publicKey: 'BPUB', enabled: true, configError: null });
    assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'nope' } })).status, 400);
    const first = await call('POST', '/api/push/subscribe', { subscription: sub(1), device: 'iPhone', standalone: true });
    assert.deepEqual([first.known, first.count, first.push.device.device, first.push.device.ackAt], [false, 1, 'iPhone', null]);
    const auto = await call('POST', '/api/push/subscribe', { subscription: sub(1), device: 'iPhone', standalone: true, auto: true });
    assert.equal(auto.known, true, '앱을 다시 열면 이미 아는 구독');
    let st = await call('POST', '/api/push/status', { endpoint: sub(1).endpoint });
    assert.deepEqual([st.enabled, st.known, st.count, st.device.ackAt, st.lastTest], [true, true, 1, null, null]);
    // 테스트 알림
    const t = await call('POST', '/api/push/test', { endpoint: sub(1).endpoint });
    assert.deepEqual([t.status, t.ok, t.sent, t.failed, t.gone], [200, true, 1, [], 0]);
    const p = h.send.sent[0].payload;
    assert.deepEqual([p.kind, p.tag, p.url, p.ack, h.send.sent[0].opt.TTL], ['test', 'kubus-test', '/#settings', t.id, 120]);
    assert.match(p.title, /테스트 알림/);
    assert.match(p.body, /17:00 보냄/, '서울 시각');
    assert.equal(t.push.lastTest.ackAt, null, '아직 확인 필요');
    assert.equal((await call('POST', '/api/push/test', { endpoint: sub(1).endpoint })).status, 429, '10초에 한 번');
    // 서비스 워커가 '받았음'(사용자 헤더 없이 알림 번호로)
    assert.equal((await call('POST', '/api/push/ack', { id: 'bad id!' }, '')).status, 400);
    assert.equal((await call('POST', '/api/push/ack', { id: 'unknownid' }, '')).status, 404);
    assert.equal((await call('POST', '/api/push/ack', { id: t.id }, 'someone-else')).ok, true);
    st = await call('POST', '/api/push/status', { endpoint: sub(1).endpoint });
    assert.equal(st.lastTest.ackAt, '2026-11-17T08:00:00.000Z');
    assert.equal(st.device.ackAt, '2026-11-17T08:00:00.000Z', '주소 없이 와도 그 기기를 수신 확인됨으로');
    // 다른 기기 · 기기 지우기
    assert.equal((await call('POST', '/api/push/test', { endpoint: sub(9).endpoint })).status, 404);
    await call('POST', '/api/push/subscribe', { subscription: sub(2), device: 'PC' });
    assert.equal((await call('POST', '/api/push/unsubscribe', { endpoint: sub(2).endpoint })).count, 1);
    assert.equal((await call('GET', '/api/me')).pushSubscriptions, 1);
    assert.ok(!('pushLog' in (await call('GET', '/api/me'))) && !('handoff' in (await call('GET', '/api/me'))));
  });
});

test('만료된 구독(410)은 보내다가 지우고, 알림 서버가 거절하면 502 + 이유 · VAPID 없으면 503', async () => {
  const h = harness({ statusOf: (ep) => (ep.endsWith('1') ? 410 : 201) });
  await serve(h, async (call) => {
    await call('POST', '/api/push/subscribe', { subscription: sub(1) });
    const r = await call('POST', '/api/push/test', { endpoint: sub(1).endpoint });
    assert.deepEqual([r.status, r.ok, r.gone], [502, false, 1]);
    assert.match(r.error, /410/);
    assert.equal(h.store.user('u1').push.length, 0, '만료된 구독을 지움');
    assert.equal((await call('POST', '/api/push/test', {})).status, 404, '알림을 켠 기기가 없음');
  });
  await serve(harness({ vapid: false }), async (call) => {
    await call('POST', '/api/push/subscribe', { subscription: sub(1) });
    const r = await call('POST', '/api/push/test', {});
    assert.deepEqual([r.status, r.kind], [503, 'no-vapid']);
  });
});

test('구독 바뀜(pushsubscriptionchange): 예전 주소로 사용자를 찾아 새 구독으로 바꿈', async () => {
  const h = harness();
  await serve(h, async (call) => {
    await call('POST', '/api/push/subscribe', { subscription: sub(1), device: 'Android' });
    assert.equal((await call('POST', '/api/push/rotate', { oldEndpoint: 'https://x/unknown', subscription: sub(2) }, '')).status, 404);
    assert.equal((await call('POST', '/api/push/rotate', { oldEndpoint: sub(1).endpoint, subscription: sub(2) }, '')).ok, true);
    const u = h.store.user('u1');
    assert.deepEqual([u.push.length, u.push[0].endpoint, u.push[0].device], [1, sub(2).endpoint, 'Android']);
  });
});

test('홈 화면 앱 이어받기: 코드(2시간 · 1회) → 홈 화면 앱이 처음 열릴 때 같은 사용자로', async () => {
  const h = harness();
  await serve(h, async (call) => {
    await call('PATCH', '/api/me', { stop: { arsId: '08901', name: '정릉시장' } });
    const a = await call('POST', '/api/me/handoff', {});
    assert.match(a.token, /^[\w-]{12}$/);
    assert.equal(a.expiresAt, '2026-11-17T10:00:00.000Z');
    assert.equal((await call('POST', '/api/me/handoff', {})).token, a.token, '30분 넘게 남았으면 같은 코드');
    assert.equal((await call('POST', '/api/handoff/claim', { token: 'x' }, 'fresh')).status, 400);
    assert.equal((await call('POST', '/api/handoff/claim', { token: 'AAAAAAAAAAAA' }, 'fresh')).status, 404);
    const c = await call('POST', '/api/handoff/claim', { token: a.token }, 'fresh');
    assert.deepEqual([c.ok, c.userId, c.hasData], [true, 'u1', true]);
    assert.equal((await call('POST', '/api/handoff/claim', { token: a.token }, 'fresh2')).status, 410, '한 번만');
    const b = await call('POST', '/api/me/handoff', {});
    assert.notEqual(b.token, a.token, '쓴 코드는 새로');
    h.clock.t += 3 * 3600_000;
    assert.equal((await call('POST', '/api/handoff/claim', { token: b.token }, 'fresh3')).status, 410, '2시간 지나면 끝');
  });
});

test('/api/wake(서버 깨우기) · /api/health(저장소 · 푸시 설정) · 저장소를 다 읽기 전에는 요청을 기다림', async () => {
  let release;
  const h = harness({ ready: new Promise((r) => { release = r; }) });
  await serve(h, async (call) => {
    const pending = call('GET', '/api/wake');
    const early = await Promise.race([pending.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 80))]);
    assert.equal(early, 'waiting');
    release();
    const w = await pending;
    assert.deepEqual([w.ok, w.storage, w.schedulerLastTickAt], [true, { kind: 'memory', loaded: true }, '2026-11-17T07:59:00.000Z']);
    const hh = await call('GET', '/api/health');
    assert.deepEqual([hh.push.enabled, hh.push.configError, hh.storage.kind], [true, null, 'memory']);
  });
});

test('스케줄러 출발 알림: 수신 확인 번호를 실어 보내고 기록 → ack 오면 마지막 출발 알림이 수신 확인됨', async () => {
  const store = createStore(null);
  store.update('demo', (u) => {
    u.classes = [{ id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' }];
    u.stop = { arsId: '08901', name: '정릉시장' };
    upsertSubscription(u, sub(1), { device: 'iPhone', now: 1 });
  });
  const send = fakeSend();
  const pusher = createPusher({ VAPID_PUBLIC_KEY: 'BPUB', VAPID_PRIVATE_KEY: 'PRIV' }, quiet, { sendImpl: send });
  const t = new Date(Date.UTC(2026, 10, 8, 23, 25)); // 서울 월 08:25
  const s = createScheduler({ store, provider: createMockProvider('jeongneung'), pusher, now: () => t, log: quiet });
  const sent = await s.tick();
  assert.deepEqual(sent.map((x) => [x.types, x.delivered]), [[['depart'], 1]]);
  const p = send.sent[0].payload;
  assert.equal(p.kind, 'alarm');
  const sum = pushSummary(store.user('demo'));
  assert.deepEqual([sum.lastAlarm.id, sum.lastAlarm.sent, sum.lastAlarm.ackAt], [p.ack, 1, null]);
  const app = createApp({ store, provider: createMockProvider(), pusher, now: () => t, courses: { meta: { available: false }, courses: [] } });
  await serve({ app }, async (call) => {
    await call('POST', '/api/push/ack', { id: p.ack, endpoint: sub(1).endpoint }, '');
    assert.ok(pushSummary(store.user('demo')).lastAlarm.ackAt);
  });
});
