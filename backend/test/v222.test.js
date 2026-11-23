// v2.2.2 서버 점검: 사용자 ID 동작은 예전 그대로(헤더 값 = 사용자, 없으면 'demo') + /api/health 'identity'로
//   ID 종류별 개수 · 'demo'로 온 요청 수 · 공용 'demo' 기록의 크기만 보여 줌(ID 값 · 내용은 싣지 않음). 메모리 저장소만 씀.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { newUserId } from '../../shared/userId.js';

const provider = { name: 'mock', stopTrips: async () => ({ trips: [], source: 'mock' }), stopArrivals: async () => ({ arrivals: [] }), health: () => ({ provider: 'mock', reason: 'demo' }) };

async function server() {
  const store = createStore(null);
  const app = createApp({ store, provider, pusher: { enabled: false, publicKey: null }, now: () => new Date('2026-11-23T12:00:00Z') });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, uid) => {
    const headers = { 'content-type': 'application/json', ...(uid === undefined ? {} : { 'x-user-id': uid }) };
    const r = await fetch(base + p, { method, headers, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { store, req, close: () => new Promise((r) => srv.close(r)) };
}
const CLASS = { name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };

test("사용자 ID: 새 긴 ID · 예전 8자 ID 모두 예전처럼 각자의 기록 · 헤더 없는 요청과 'demo' 헤더는 예전처럼 공용 'demo'", async () => {
  const { store, req, close } = await server();
  try {
    const long = newUserId((n) => globalThis.crypto.getRandomValues(new Uint8Array(n))), short = 'u3k9x2m1p';
    assert.equal((await req('PUT', '/api/me/timetable', { classes: [CLASS] }, long)).status, 200);
    assert.equal((await req('GET', '/api/me', null, long)).body.classes.length, 1, '새 긴 ID로 저장 · 읽기');
    assert.equal((await req('GET', '/api/me', null, short)).body.classes.length, 0, '예전 8자 ID는 다른 사용자(자기 기록)');
    await req('PUT', '/api/me/timetable', { classes: [CLASS, { ...CLASS, day: 2 }] }, short);
    assert.deepEqual([store.user(long).classes.length, store.user(short).classes.length], [1, 2]);
    // 예전 화면(저장 공간이 막힌 기기)이 보내던 'demo' 헤더 · 헤더 없는 요청은 지금처럼 'demo' — 동작을 바꾸지 않음
    await req('PUT', '/api/me/timetable', { classes: [CLASS] }, 'demo');
    assert.equal((await req('GET', '/api/me', null, undefined)).body.classes.length, 1);
  } finally { await close(); }
});

test("/api/health identity: ID 종류별 개수 · 'demo'로 온 요청 수(헤더 없는 요청 · 서비스 워커는 세지 않음) · 공용 기록 크기 — ID 값은 싣지 않음", async () => {
  const { req, close } = await server();
  try {
    let h = (await req('GET', '/api/health', null, undefined)).body.identity;
    assert.deepEqual(h, { users: { long: 0, short: 0, other: 0 }, demoUser: null, demoHeader: 0, demoHeaderLastAt: null }, '처음: 아무도 없음');
    const longs = [0, 1, 2].map(() => newUserId((n) => globalThis.crypto.getRandomValues(new Uint8Array(n))));
    for (const id of longs) await req('GET', '/api/me', null, id);
    await req('GET', '/api/me', null, 'u3k9x2m1p');
    await req('GET', '/api/me', null, 'e2e1732000000');
    await req('GET', '/api/wake', null, undefined);                         // cron-job.org(헤더 없음)
    await req('POST', '/api/push/ack', { id: 'abcdef123', endpoint: null }, undefined); // 서비스 워커(헤더 없음) → 404여도 세지 않음
    const res = await req('GET', '/api/health', null, longs[0]);
    h = res.body.identity;
    assert.deepEqual([h.users, h.demoHeader, h.demoHeaderLastAt], [{ long: 3, short: 1, other: 1 }, 0, null]);
    assert.equal(h.demoUser, null, "헤더 없는 요청이 공용 'demo'를 읽기만 했으면 저장된 기록 없음 표시는 그대로");
    assert.ok(!JSON.stringify(res.body).includes(longs[1]) && !JSON.stringify(res.body).includes('u3k9x2m1p'), 'ID 값은 응답에 없음');
    // 예전 화면처럼 'demo'를 보내면 셈 + 공용 기록의 크기(수업 · 구독 개수)만
    await req('PUT', '/api/me/timetable', { classes: [CLASS, CLASS] }, 'demo');
    await req('GET', '/api/me', null, ' demo ');
    h = (await req('GET', '/api/health', null, undefined)).body.identity;
    assert.deepEqual([h.demoHeader, h.demoHeaderLastAt, h.demoUser], [2, '2026-11-23T12:00:00.000Z', { classes: 2, push: 0, saved: true }]);
    assert.equal(h.users.long, 3, "'demo'는 종류별 개수에 넣지 않음");
  } finally { await close(); }
});
