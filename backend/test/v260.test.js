// v2.6.0 환승 지하철 실시간(서버) 점검:
//   화면이 '다음 탈 환승 지하철'을 알려 줄 때만(?next=&at=) · '출발했어요!' 기록 · 환승 지하철 · 허용 목록 · 비상 끄기 · 예정 탑승 ±15분 안에서만 서울시를 부름 ·
//   한 번에 역 하나 · 1분 안에 받은 값은 다시 씀 · 하루 몫(SEOUL_SUBWAY_MID_DAILY_CAP, 비우면 300 · 0이면 끔 · 900 안에서) · 다 써도 첫 지하철은 그대로 ·
//   서버 출발 알림(planFor)에는 없음 · /api/health 개수만(역 · 노선 이름 없음) · .env.example 값은 비어 있음 ·
//   v2.7.0 준비: 종류별 받아 오기(지금은 지하철만) · 다시 쓸 수 있는 하루 몫(midBudget).
//   가짜 서울시 지하철만 씁니다(실제 호출 없음). 경로 · 열차는 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MID_DEFAULT_CAP, createSubwayService, parseMidCap } from '../src/transit/seoulSubway.js';
import { MID_REUSE_SEC, createMidBudget } from '../src/transit/midBudget.js';
import { MID_FETCH, midKinds } from '../src/transit/midLive.js';
import { createKv } from '../src/transit/kv.js';
import { transitLive } from '../src/transit/transitLive.js';
import { createMockProvider } from '../src/transit/index.js';
import { planFor } from '../src/planner.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { fakeSubwayFetch, SUBWAY_TEST_KEY } from './fixtures/subwayFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult, planTransit, routeKey } from '../../shared/transitPlan.js';
import { arrivalKey } from '../../shared/arrival.js';
import { seoulParts } from '../../shared/time.js';

const quiet = { warn() {}, info() {}, error() {} };
const kst = (s) => new Date(`${s}+09:00`).getTime();
const ROUTE = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0]; // 2호선 홍대입구 → 4호선 동대문역사문화공원 → 1213(예시)
const CLS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' }; // 월요일
const DEP = 7 * 60 + 40; // 07:40 '출발했어요!' → 4호선 08:12 도착 · 08:16 예정 탑승 → 08:01 ~ 08:31
const NOW = kst('2026-11-16T08:05:00');
const HINT = { i: 3, at: 492 };
const MID_ST = '동대문역사문화공원';
const service = ({ env = {}, t = NOW } = {}) => {
  const clock = { t };
  const f = fakeSubwayFetch({ clock: () => clock.t });
  const s = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY, ...env }, fetchImpl: f, clock: () => clock.t, log: quiet });
  return { s, f, clock, midCalls: () => f.calls.filter((c) => c.station === MID_ST).length };
};
const live = (s, { t = NOW, midHint = HINT, departedMin = DEP, route = ROUTE, cls = CLS } = {}) =>
  transitLive({ route, provider: createMockProvider('jeongneung'), subway: s, nowDate: new Date(t), cls, walkTable: {}, departedMin, midHint });

test('알려 주지 않으면 부르지 않음 · 08:05 다음 탈 4호선을 알려 주면 그 역 한 곳만(첫 지하철 · 다른 역은 부르지 않음)', async () => {
  const a = service();
  const none = await live(a.s, { midHint: null });
  assert.equal('mid' in none, false);
  assert.equal(a.midCalls(), 0);
  const b = service();
  const out = await live(b.s);
  assert.deepEqual([out.mid.i, out.mid.kind, out.mid.source, out.mid.station, out.mid.line], [3, 'subway', 'seoul', MID_ST, '4호선']);
  assert.deepEqual(out.mid.trains.map((t) => [t.etaSec, t.dest]), [[180, '불암산'], [480, '불암산']]);
  assert.deepEqual(b.f.calls.map((c) => c.station), [MID_ST], '08:05는 첫 지하철 실시간 시간(07:10 ~ 08:00) 밖 → 부른 역은 하나');
  assert.equal(out.first.source, 'skip');
  const h = b.s.health().mid;
  assert.deepEqual([h.cap, h.callsToday, h.used, h.capReached, h.reuseSec], [300, 1, 1, false, 60]);
  assert.equal(b.s.health().callsToday, 1, '하루 900회 상한에도 같이 셈');
});

test('부르지 않음: 출발 기록 없음 · 환승 지하철 아님(첫 구간 · 버스) · 탑승 15분 전보다 이름(07:50) · 지남(08:32) → skip, 개수만 셈', async () => {
  const { s, midCalls } = service();
  const cases = [
    [{ departedMin: null }, 'not-departed'],
    [{ midHint: { i: 1, at: 464 } }, 'not-transfer'],
    [{ midHint: { i: 5, at: 511 } }, 'not-transfer'],
    [{ t: kst('2026-11-16T07:50:00') }, 'not-yet'],
    [{ t: kst('2026-11-16T08:32:00') }, 'passed'],
  ];
  for (const [o, reason] of cases) {
    const out = await live(s, o);
    assert.deepEqual([out.mid.source, out.mid.reason, out.mid.trains], ['skip', reason, []], reason);
  }
  assert.equal(midCalls(), 0, '환승 지하철 역은 한 번도 부르지 않음');
  const h = s.health().mid;
  // 개수는 알려 준 구간의 종류 쪽에 셈: 첫 구간(2호선)은 지하철 쪽 · 마지막 버스(1213)는 지하철이 아니라 여기서 세지 않음
  assert.deepEqual([h.callsToday, h.used, h.skipped], [0, 0, { notDeparted: 1, notTransfer: 1, notYet: 1, passed: 1, line: 0, off: 0 }]);
});

test('허용 목록 밖 노선 · 비상 끄기(SEOUL_SUBWAY_OFF_LINES=1004) → nodata(실시간 없음), 부르지 않음', async () => {
  const a = service();
  const other = { ...ROUTE, legs: ROUTE.legs.map((l, i) => (i === 3 ? { ...l, subwayId: '1099' } : l)) };
  const o1 = await live(a.s, { route: other });
  assert.deepEqual([o1.mid.source, o1.mid.reason, a.midCalls()], ['nodata', 'line', 0]);
  const b = service({ env: { SEOUL_SUBWAY_OFF_LINES: '1004' } });
  const o2 = await live(b.s);
  assert.deepEqual([o2.mid.source, o2.mid.reason, b.midCalls()], ['nodata', 'off', 0]);
  assert.deepEqual([a.s.health().mid.skipped.line, b.s.health().mid.skipped.off], [1, 1]);
});

test('기기 값이 서버 표준값(08:16)의 −15 ~ +30분 밖이면 표준값으로(창은 08:01 ~ 08:31 그대로) · 바꾼 수(clamped)를 셈', async () => {
  const { s, midCalls } = service();
  const out = await live(s, { midHint: { i: 3, at: 600 } });
  assert.deepEqual([out.mid.source, midCalls()], ['seoul', 1]);
  assert.equal(s.health().mid.clamped, 1);
  const late = await live(s, { midHint: { i: 3, at: 600 }, t: kst('2026-11-16T08:32:00') });
  assert.deepEqual([late.mid.source, late.mid.reason], ['skip', 'passed'], '기기 값(10:04)을 따르지 않음');
});

test('1분 안에 받은 값은 다시 씀(40초 뒤: 부르지 않고 흐른 시간만큼 빼서) · 70초 뒤에는 새로', async () => {
  const { s, clock, midCalls } = service();
  await live(s);
  clock.t = NOW + 40_000;
  const o40 = await live(s, { t: clock.t });
  assert.deepEqual([midCalls(), o40.mid.trains.map((t) => t.etaSec)], [1, [140, 440]]);
  clock.t = NOW + 70_000;
  const o70 = await live(s, { t: clock.t });
  assert.deepEqual([midCalls(), o70.mid.trains.map((t) => t.etaSec)], [2, [180, 480]]);
  assert.deepEqual([s.health().mid.callsToday, s.health().mid.used], [2, 3]);
});

test("하루 몫(SEOUL_SUBWAY_MID_DAILY_CAP=2)을 다 쓰면 환승 지하철은 부르지 않음(cap · mid-cap) · 첫 지하철은 그대로 받음 · 실패로 세지 않음", async () => {
  const { s, f, clock, midCalls } = service({ env: { SEOUL_SUBWAY_MID_DAILY_CAP: '2' } });
  await live(s);
  clock.t = NOW + 70_000; await live(s, { t: clock.t });
  clock.t = NOW + 140_000;
  const o = await live(s, { t: clock.t });
  assert.deepEqual([o.mid.source, o.mid.reason, o.mid.trains, midCalls()], ['cap', 'mid-cap', [], 2]);
  const h = s.health().mid;
  assert.deepEqual([h.cap, h.callsToday, h.capReached, h.failed, h.used], [2, 2, true, 0, 2]);
  const first = await s.arrivals('홍대입구');
  assert.deepEqual([first.source, f.calls.filter((c) => c.station === '홍대입구').length], ['seoul', 1], '첫 지하철(몫과 상관없음)은 그대로 부름');
  // 다음 날(자정 지나 08:05)에는 다시
  clock.t = NOW + 86_400_000;
  const next = await live(s, { t: clock.t });
  assert.deepEqual([next.mid.source, s.health().mid.callsToday, s.health().mid.capReached], ['seoul', 1, false]);
});

test("비상 스위치 SEOUL_SUBWAY_MID_DAILY_CAP=0 → 환승 지하철 실시간 끔(off · mid-off), 부르지 않음 · 키가 없으면 off · no-service", async () => {
  const a = service({ env: { SEOUL_SUBWAY_MID_DAILY_CAP: '0' } });
  const o = await live(a.s);
  assert.deepEqual([o.mid.source, o.mid.reason, a.midCalls(), a.s.health().mid.cap, a.s.health().mid.capReached], ['off', 'mid-off', 0, 0, false]);
  const nokey = createSubwayService({ env: {}, log: quiet });
  const o2 = await live(nokey);
  assert.deepEqual([o2.mid.source, o2.mid.reason], ['off', 'no-service']);
});

test('하루 몫 읽기: 비우면 300 · 0 · 음수 · 글자면 끔(0) · 소수는 내림 · 최대 1,000', () => {
  assert.equal(MID_DEFAULT_CAP, 300);
  const cases = [['', 300], [undefined, 300], [null, 300], ['  ', 300], ['0', 0], ['-5', 0], ['abc', 0], ['0.5', 0], ['150', 150], ['150.9', 150], [' 200 ', 200], ['5000', 1000]];
  for (const [v, want] of cases) assert.equal(parseMidCap(v), want, JSON.stringify(v));
});

test('서버 출발 알림(planFor)에는 환승 지하철 실시간이 없음(화면 요청만)', async () => {
  const { s, midCalls } = service();
  const dateKey = seoulParts(new Date(NOW)).dateKey;
  const user = { classes: [CLS], stop: null, prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {}, personal: { offsetMin: 0 }, arrivals: [],
    transit: { mode: 'transit', route: ROUTE }, departure: { key: arrivalKey(dateKey, CLS), at: new Date(NOW - 25 * 60_000).toISOString(), departMin: DEP, routeKey: routeKey(ROUTE) } };
  const r = await planFor(user, createMockProvider('jeongneung'), new Date(NOW), { windowMin: 180, subway: s });
  assert.ok(r.live && r.departed, '출발 기록이 있고 실시간 재료도 받은 계산');
  assert.equal(r.live.mid, undefined);
  assert.equal(midCalls(), 0);
});

test('API: /api/transit/live ?next=&at= 맞는 값일 때만 · 출발 기록이 없으면 skip · /api/health seoulSubway.mid(개수만) · .env.example 값은 비어 있음', async () => {
  const { s, f, midCalls } = service();
  const store = createStore(null);
  const uid = 'u0123456789abcdef0123456789abcd26', other = 'u0123456789abcdef0123456789abce26';
  const dateKey = seoulParts(new Date(NOW)).dateKey;
  for (const id of [uid, other]) store.update(id, (u) => { u.classes = [CLS]; u.transit = { mode: 'transit', origin: { name: '홍대입구역', kind: 'stop' }, route: ROUTE, savedAt: new Date(NOW - 3600_000).toISOString(), retry: null }; });
  store.update(uid, (u) => { u.departure = { key: arrivalKey(dateKey, CLS), at: new Date(NOW - 25 * 60_000).toISOString(), departMin: DEP, routeKey: routeKey(ROUTE) }; });
  const app = createApp({ store, provider: createMockProvider('jeongneung'), pusher: { enabled: false, publicKey: null }, now: () => new Date(NOW), subway: s });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p, id = uid) => (await fetch(base + p, { headers: { 'x-user-id': id } })).json();
  try {
    for (const q of ['', '?next=3', '?at=492', '?next=abc&at=492', '?next=-1&at=492', '?next=3.5&at=492', '?next=3&at=99999', '?next=3&at=-1', '?next=100&at=492']) {
      assert.equal('mid' in (await get(`/api/transit/live${q}`)), false, q);
    }
    assert.equal(midCalls(), 0);
    const ok = await get('/api/transit/live?next=3&at=492');
    assert.deepEqual([ok.mid.source, ok.mid.station, ok.mid.line, ok.mid.trains.length, midCalls()], ['seoul', MID_ST, '4호선', 2, 1]);
    const notDeparted = await get('/api/transit/live?next=3&at=492', other);
    assert.deepEqual([notDeparted.mid.source, notDeparted.mid.reason, midCalls()], ['skip', 'not-departed', 1]);
    const h = (await get('/api/health')).seoulSubway.mid;
    assert.deepEqual([h.cap, h.callsToday, h.used, h.capReached, h.reuseSec, h.skipped.notDeparted], [300, 1, 1, false, 60, 1]);
    const hd = JSON.stringify(h);
    assert.ok(!hd.includes('동대문') && !hd.includes('4호선') && !hd.includes('1004'), `health에는 개수만: ${hd}`);
    assert.ok(!f.calls.some((c) => c.raw.includes(uid) || c.raw.includes(other)), '서울시 요청에 사용자 번호 없음');
  } finally { srv.close(); }
  const ex = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(ex, /^SEOUL_SUBWAY_MID_DAILY_CAP=$/m);
});

test('표준값 확인(이 파일의 기준): 07:40 출발 → 4호선 08:12 도착 · 08:16 예정 탑승', () => {
  const p = planTransit({ route: ROUTE, cls: CLS, nowMin: 485, walkTable: {}, departedMin: DEP });
  const l = p.pick.legs.find((x) => x.i === 3 && x.kind === 'subway');
  assert.deepEqual([l.arrive, l.board], [492, 496]);
});

test('v2.7.0 준비: 종류별 받아 오기는 지금 지하철만(켠 종류 = 공용 MID_LIVE_KINDS ∩ 받아 오기) · 중간 버스를 알려 줘도 부르지 않음(어느 API도)', async () => {
  assert.deepEqual(Object.keys(MID_FETCH), ['subway']);
  assert.deepEqual(midKinds(), ['subway']);
  // 예시 경로에 중간 버스(7016, 예시)를 넣은 경로: 2호선 → 7016 → 1213
  const L = ROUTE.legs;
  const busMid = { ...ROUTE, legs: [L[0], L[1], L[2], { ...L[5], no: '7016', from: { ...L[5].from, name: '시청' } }, L[4], L[5], L[6]] };
  const { s, f } = service();
  const prov = createMockProvider('jeongneung'), seen = [];
  const spy = { ...prov, stopArrivals: async (...a) => { seen.push(['stopArrivals', ...a]); return prov.stopArrivals(...a); } };
  const out = await transitLive({ route: busMid, provider: spy, subway: s, nowDate: new Date(NOW), cls: CLS, walkTable: {}, departedMin: DEP, midHint: { i: 3, at: 492 } });
  assert.deepEqual([out.mid.source, out.mid.reason, out.mid.kind, f.calls.length, seen.length], ['skip', 'not-transfer', 'bus', 0, 0]);
  assert.equal(s.health().mid.skipped.notTransfer, 0, '지하철 쪽에 세지 않음');
});

test('v2.7.0 준비: 하루 몫(midBudget) — 새로 부를 때만 셈 · 다 쓰면 over · 0이면 꺼짐 · 자정에 새로 · 외부 DB 값 이어받기 · 개수만', async () => {
  const day = { d: '2026-11-16' };
  const b = createMidBudget({ cap: 2, keyOf: (d) => `kubusai:test:mid:${d}`, today: () => day.d });
  assert.deepEqual([b.cap, b.over(), MID_REUSE_SEC], [2, false, 60]);
  b.take(); b.take();
  assert.equal(b.over(), true);
  b.note('used'); b.note('notYet'); b.note('clamped'); b.note('nonsense');
  assert.deepEqual(b.health(), { cap: 2, callsToday: 2, capReached: true, reuseSec: 60, used: 1, empty: 0, failed: 0, clamped: 1, skipped: { notDeparted: 0, notTransfer: 0, notYet: 1, passed: 0, line: 0, off: 0 } });
  day.d = '2026-11-17';
  assert.deepEqual([b.over(), b.health().callsToday, b.health().used], [false, 0, 0], '자정이 지나면 새로');
  const off = createMidBudget({ cap: 0, keyOf: (d) => d, today: () => day.d });
  assert.deepEqual([off.over(), off.health().capReached], [true, false], '0이면 늘 다 쓴 것(부르지 않음) · capReached는 거짓(꺼짐)');
  // 서버를 다시 켜도 그날 외부 DB 값을 이어받음(다른 서비스와 키가 겹치지 않게 keyOf로 나눔)
  const kv = createKv({ clock: () => kst('2026-11-16T08:05:00') });
  for (let k = 0; k < 5; k++) await kv.incr('kubusai:bus:mid:2026-11-16', 60);
  const again = createMidBudget({ cap: 300, kv, keyOf: (d) => `kubusai:bus:mid:${d}`, today: () => '2026-11-16' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(again.health().callsToday, 5);
  again.take();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([again.health().callsToday, await kv.getNum('kubusai:bus:mid:2026-11-16')], [6, 6]);
});

