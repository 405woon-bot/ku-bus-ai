// v2.6.0 환승 지하철 실시간(공용 계산) 점검:
//   환승 지하철 구간 · 화면이 서버에 알려 줄 '다음 탈 환승 지하철'('출발했어요!' 뒤 · 다음 탈 구간이 환승 지하철일 때만 · 한 곳) ·
//   서버가 부를지(출발 기록 · 환승 지하철 · 허용 목록 · 비상 끄기 · 예정 탑승 ±15분 · 기기 값이 표준값 −15 ~ +30분 밖이면 표준값) ·
//   받은 열차로 탈 시각(승강장 2분) → 뒤 구간 다시 계산(환승 여유 3분 그대로) · 이미 탄 구간 고정값 · 지난 구간 규칙 · 첫 구간 · 버스 구간 · 출발 전에는 쓰지 않음 ·
//   구간 종류와 상관없는 계산(v2.7.0부터 중간 환승 버스도 같은 규칙으로 — 지하철만 고르면 v2.6.0과 같음).
//   예시 경로(2호선 홍대입구 → 4호선 동대문역사문화공원 → 1213 길음역)와 열차 · 버스는 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_ODSAY_RESPONSE } from './samples/odsaySample.js';
import { MID_LIVE_KINDS, TRANSIT, lockPins, midCheck, midHint, parseOdsayResult, planTransit, simulate, stdWait, transferLegs, transferSubways } from './transitPlan.js';

const ROUTE = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0];
const CLS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const DEP = 7 * 60 + 40; // 07:40 '출발했어요!'
const plan = (nowMin, o = {}) => planTransit({ route: ROUTE, cls: CLS, nowMin, walkTable: {}, departedMin: DEP, ...o });
const legOf = (p, i) => p.pick.legs.find((l) => l.i === i && l.kind !== 'walk');
const mid = (trains, i = 3) => ({ mid: { i, kind: 'subway', source: 'seoul', trains } });
const at = (h, m) => h * 60 + m;
// 실제 사용자 경로 모양(버스 → 공항철도 → 4호선 → 버스)을 예시 경로 구간으로 만든 것(정류장 · 역 이름은 예시)
const L = ROUTE.legs;
const TWO = { ...ROUTE, legs: [
  L[0], { ...L[5], no: '81-1', from: { ...L[5].from, name: '당곡고개' } }, L[2],
  { ...L[1], line: '공항철도', lineName: '공항철도', subwayId: '1065', from: { ...L[1].from, name: '계양' } }, L[2],
  { ...L[3], from: { ...L[3].from, name: '서울역' } }, L[4], { ...L[5], no: '163' }, L[6],
] };

test('예시 경로 계산(이 파일의 기준): 07:40 출발 → 2호선 07:48 탑승 · 08:06 내림 → 4호선 08:12 도착 · 08:16 탑승(표준) → 1213 08:37 탑승', () => {
  const p = plan(at(8, 5));
  assert.deepEqual(ROUTE.legs.map((l) => l.kind), ['walk', 'subway', 'walk', 'subway', 'walk', 'bus', 'walk']);
  assert.deepEqual([legOf(p, 1).board, legOf(p, 1).end, legOf(p, 3).arrive, legOf(p, 3).board, legOf(p, 5).board, p.pick.classArriveMin], [468, 486, 492, 496, 517, 537]);
  assert.equal(stdWait(ROUTE.legs[3]), 4, '4호선 배차 6분 → 표준 기다림 4분');
  assert.deepEqual([TRANSIT.midWindowMin, TRANSIT.midHintEarlyMin, TRANSIT.midHintLateMin, TRANSIT.platformMin, TRANSIT.transferSafetyMin], [15, 15, 30, 2, 3]);
});

test('환승 지하철 구간: 첫 탑승이 아닌 지하철만(마지막 구간이 지하철이어도) · 첫 구간 · 버스 · 도보는 아님', () => {
  assert.deepEqual(transferSubways(ROUTE), [3]);
  assert.deepEqual(transferSubways(TWO), [3, 5], '버스 → 공항철도 → 4호선 → 버스: 지하철 둘 다 환승 지하철');
  assert.deepEqual(transferSubways({ legs: [{ kind: 'walk' }, { kind: 'subway' }, { kind: 'walk' }, { kind: 'bus' }] }), [], '첫 지하철만 있는 경로');
  assert.deepEqual(transferSubways({ legs: [{ kind: 'bus' }, { kind: 'subway' }, { kind: 'subway' }] }), [1, 2], '같은 역에서 바로 갈아타는 지하철도');
  assert.deepEqual([transferSubways(null), transferSubways({})], [[], []]);
});

test("다음 탈 환승 지하철(화면 → 서버): '출발했어요!' 뒤 다음 탈 구간이 환승 지하철일 때만 · 그 역 도착 예상(이 기기 계산)", () => {
  // 출발 전: 없음
  const before = planTransit({ route: ROUTE, cls: CLS, nowMin: at(7, 30), walkTable: {} });
  assert.equal(midHint(before, ROUTE, at(7, 30)), null);
  // 07:42 다음 탈 것은 첫 지하철(2호선) → 없음(첫 지하철은 지금처럼 출발 30분 전부터)
  assert.equal(midHint(plan(at(7, 42)), ROUTE, at(7, 42)), null);
  // 2호선을 탄 뒤(07:50 · 08:05) · 내린 뒤(08:10): 4호선, 동대문역사문화공원 도착 예상 08:12(492)
  for (const now of [at(7, 50), at(8, 5), at(8, 10)]) assert.deepEqual(midHint(plan(now), ROUTE, now), { i: 3, at: 492 }, String(now));
  // 4호선을 탄 뒤(08:20): 다음 탈 것은 버스 → 없음
  assert.equal(midHint(plan(at(8, 20)), ROUTE, at(8, 20)), null);
  // 이미 탄 구간 고정값(첫 지하철을 실시간으로 07:50에 탔음)이 들어간 이 기기 계산을 그대로 알려 줌: 08:08 + 걸어서 3분 + 여유 3분 = 08:14(494)
  const pinned = plan(at(7, 55), { pins: { 1: { board: 470, ride: 18, src: 'live' } } });
  assert.deepEqual(midHint(pinned, ROUTE, at(7, 55)), { i: 3, at: 494 });
  // 소수는 0.1분 단위로
  const odd = plan(at(7, 55), { pins: { 1: { board: 470.237, ride: 18, src: 'live' } } });
  assert.deepEqual(midHint(odd, ROUTE, at(7, 55)), { i: 3, at: 494.2 });
});

test('환승 지하철이 둘인 경로: 한 번에 한 곳(다음 탈 곳)만 — 공항철도를 타면 다음은 4호선 · 4호선을 타면 없음', () => {
  const dep = at(7, 0), p = (now) => planTransit({ route: TWO, cls: CLS, nowMin: now, walkTable: {}, departedMin: dep });
  const legs = (now) => p(now).pick.legs.filter((l) => l.kind !== 'walk');
  const [bus, arex, line4] = legs(at(7, 1));
  assert.equal(midHint(p(bus.board - 1), TWO, bus.board - 1), null, '첫 버스를 타기 전: 없음');
  assert.deepEqual(midHint(p(bus.board + 1), TWO, bus.board + 1), { i: 3, at: arex.arrive }, '첫 버스를 탄 뒤: 공항철도');
  assert.deepEqual(midHint(p(arex.board + 1), TWO, arex.board + 1), { i: 5, at: line4.arrive }, '공항철도를 탄 뒤: 4호선');
  assert.equal(midHint(p(line4.board + 1), TWO, line4.board + 1), null, '4호선을 탄 뒤: 다음은 버스');
});

test('서버가 부를지: 알려 준 값 없음 · 출발 기록 없음 · 환승 지하철 아님(첫 구간 · 버스 · 도보 · 없는 구간) → 부르지 않음', () => {
  const std = plan(at(8, 5));
  for (const h of [null, undefined, {}, { i: 'x', at: 492 }, { i: 3 }, { i: 3, at: NaN }, { i: 3.5, at: 492 }]) assert.deepEqual(midCheck(ROUTE, std, h, at(8, 5)), { ok: false, reason: 'no-hint' }, JSON.stringify(h));
  const notDeparted = planTransit({ route: ROUTE, cls: CLS, nowMin: at(8, 5), walkTable: {} });
  assert.deepEqual(midCheck(ROUTE, notDeparted, { i: 3, at: 492 }, at(8, 5)), { ok: false, reason: 'not-departed', i: 3 });
  assert.deepEqual(midCheck(ROUTE, null, { i: 3, at: 492 }, at(8, 5)), { ok: false, reason: 'not-departed', i: 3 });
  for (const i of [1, 5, 2, 0, 99]) assert.deepEqual(midCheck(ROUTE, std, { i, at: 492 }, at(8, 5)), { ok: false, reason: 'not-transfer', i }, String(i));
});

test('서버가 부를지: 실시간 허용 목록 밖 노선(line) · 비상 끄기(off) → 부르지 않음', () => {
  const other = { ...ROUTE, legs: ROUTE.legs.map((l, i) => (i === 3 ? { ...l, subwayId: '1099' } : l)) };
  assert.deepEqual(midCheck(other, plan(at(8, 5), { route: other }), { i: 3, at: 492 }, at(8, 5)), { ok: false, reason: 'line', i: 3, kind: 'subway' });
  const none = { ...ROUTE, legs: ROUTE.legs.map((l, i) => (i === 3 ? { ...l, subwayId: '' } : l)) };
  assert.equal(midCheck(none, plan(at(8, 5), { route: none }), { i: 3, at: 492 }, at(8, 5)).reason, 'line');
  assert.deepEqual(midCheck(ROUTE, plan(at(8, 5)), { i: 3, at: 492 }, at(8, 5), { offLines: new Set(['1004']) }), { ok: false, reason: 'off', i: 3, kind: 'subway' });
  assert.equal(midCheck(ROUTE, plan(at(8, 5)), { i: 3, at: 492 }, at(8, 5), { offLines: new Set(['1065']) }).ok, true, '다른 노선을 끈 것은 상관없음');
});

test('예정 탑승 ±15분(경계 포함): 기준 T = 알려 준 도착 예상 + 표준 기다림(08:12 + 4분 = 08:16) → 08:01 ~ 08:31', () => {
  const std = plan(at(8, 5)), h = { i: 3, at: 492 };
  const w = { i: 3, kind: 'subway', T: 496, S: 496, clamped: false };
  assert.deepEqual(midCheck(ROUTE, std, h, 481), { ok: true, ...w });
  assert.deepEqual(midCheck(ROUTE, std, h, 480.9), { ok: false, reason: 'not-yet', ...w });
  assert.deepEqual(midCheck(ROUTE, std, h, 511), { ok: true, ...w });
  assert.deepEqual(midCheck(ROUTE, std, h, 511.1), { ok: false, reason: 'passed', ...w });
  assert.deepEqual(midCheck(ROUTE, std, h, at(7, 50)), { ok: false, reason: 'not-yet', ...w }, "07:50: '환승 지하철 실시간은 탑승 15분 전부터'");
  // 앞 구간이 늦어진 기기 값(08:20 도착 → T 08:24)은 그대로 받음 — 창도 함께 밀림(08:09 ~ 08:39)
  assert.deepEqual(midCheck(ROUTE, std, { i: 3, at: 500 }, at(8, 38)), { ok: true, i: 3, kind: 'subway', T: 504, S: 496, clamped: false });
  assert.equal(midCheck(ROUTE, std, { i: 3, at: 500 }, at(8, 8)).reason, 'not-yet');
});

test('기기 값이 서버 표준값(S = 08:16)의 −15분 ~ +30분 밖이면 쓰지 않고 S로(경계 포함 · clamped 표시)', () => {
  const std = plan(at(8, 5)), S = 496;
  const T = (a) => midCheck(ROUTE, std, { i: 3, at: a }, at(8, 5));
  assert.deepEqual([T(477).T, T(477).clamped], [S - 15, false], 'T = 08:01(S−15) 그대로');
  assert.deepEqual([T(476.9).T, T(476.9).clamped], [S, true], '너무 이름 → S');
  assert.deepEqual([T(522).T, T(522).clamped], [S + 30, false], 'T = 08:46(S+30) 그대로');
  assert.deepEqual([T(522.1).T, T(522.1).clamped], [S, true], '너무 늦음 → S');
  assert.deepEqual([T(0).T, T(2880).T, T(600).clamped], [S, S, true]);
  // 표준값으로 바꾼 뒤에도 창은 ±15분 그대로
  assert.equal(midCheck(ROUTE, std, { i: 3, at: 600 }, 480.9).reason, 'not-yet');
  assert.equal(midCheck(ROUTE, std, { i: 3, at: 600 }, 511.1).reason, 'passed');
});

test('받은 열차로 탈 시각: 역 도착 + 승강장 2분 뒤 첫 열차(08:14 이후) · 뒤 구간을 같은 규칙(환승 여유 3분)으로 다시 계산', () => {
  const now = at(8, 5);
  const p = plan(now, { rt: mid([{ etaSec: 180, dest: '불암산' }, { etaSec: 600, dest: '불암산' }]) }); // 08:08(못 탐) · 08:15
  const l3 = legOf(p, 3), walk4 = p.pick.legs.find((l) => l.i === 4), bus = legOf(p, 5);
  assert.deepEqual([l3.arrive, l3.board, l3.src, l3.end], [492, 495, 'live', 505]);
  assert.deepEqual([walk4.start, walk4.end, walk4.safety], [505, 510, 3]);
  assert.deepEqual([bus.arrive, bus.board, bus.src], [510, 516, 'std']);
  assert.equal(p.pick.classArriveMin, 536, '표준(537)보다 1분 빠름');
  // 승강장 2분 경계: 08:14 정각 열차는 탐 · 그보다 조금 이른 열차는 못 탐
  assert.equal(legOf(plan(now, { rt: mid([{ etaSec: 540 }]) }), 3).board, 494);
  const early = legOf(plan(now, { rt: mid([{ etaSec: 539 }]) }), 3); // 08:13:59 → 못 탐 → 배차간격(6분) 뒤 08:19:59(이어 붙인 예상)
  assert.deepEqual([Math.round(early.board * 100) / 100, early.src], [499.98, 'term']);
  // 늦게 오는 열차 → 뒤 구간이 모두 밀림
  const late = plan(now, { rt: mid([{ etaSec: 1200 }]) }); // 08:25
  assert.deepEqual([legOf(late, 3).board, legOf(late, 5).arrive, late.pick.classArriveMin], [505, 520, 546]);
});

test('받은 열차 뒤는 배차간격으로 이어 붙인 예상(term) · approx는 그대로 · 열차가 비면 표준 기다림', () => {
  const now = at(8, 5);
  const t = legOf(plan(now, { rt: mid([{ etaSec: 60 }]) }), 3); // 08:06 → +6분 08:12(못 탐) → 08:18
  assert.deepEqual([t.board, t.src], [498, 'term']);
  const a = legOf(plan(now, { rt: mid([{ etaSec: 600, approx: true }]) }), 3);
  assert.deepEqual([a.board, a.src, a.approx], [495, 'live', true]);
  const e = legOf(plan(now, { rt: mid([]) }), 3);
  assert.deepEqual([e.board, e.src], [496, 'std']);
  const nodata = legOf(plan(now, { rt: { mid: { i: 3, kind: 'subway', source: 'nodata', reason: 'no-train', trains: [] } } }), 3);
  assert.deepEqual([nodata.board, nodata.src], [496, 'std']);
});

test('이미 탄 구간 고정값이 먼저 · 표준 기다림으로도 탔을 시각이 지난 구간에는 실시간을 붙이지 않음 · 탄 뒤에는 실시간 값이 고정됨', () => {
  // 고정값(08:17 std)이 있으면 실시간보다 먼저
  const pin = legOf(plan(at(8, 17), { rt: mid([{ etaSec: 60 }]), pins: { 3: { board: 497, ride: 10, src: 'std' } } }), 3);
  assert.deepEqual([pin.board, pin.src, pin.pinned], [497, 'std', true]);
  // 고정값 없이 08:17(도착 08:12 + 4분 = 08:16이 지남) → 실시간의 '다음 열차'(08:18)를 붙이지 않음
  const passed = legOf(plan(at(8, 17), { rt: mid([{ etaSec: 60 }]) }), 3);
  assert.deepEqual([passed.board, passed.src], [496, 'std']);
  // 08:15 실시간 열차(08:15:30)로 탈 시각 → 30초 안이라 '탔음'으로 고정 → 다음 갱신에 실시간 값이 없어도 그대로
  const p = plan(at(8, 15), { rt: mid([{ etaSec: 30 }]) });
  assert.deepEqual([legOf(p, 3).board, legOf(p, 3).src], [495.5, 'live']);
  const pins = lockPins(p, at(8, 15));
  assert.deepEqual(pins[3], { board: 495.5, ride: 10, src: 'live', vehicle: '4호선', approx: false });
  const later = legOf(plan(at(8, 20), { pins }), 3);
  assert.deepEqual([later.board, later.src, later.pinned], [495.5, 'live', true]);
});

test('환승 지하철 실시간은 첫 구간 · 버스 구간 · 출발 전 계산에는 쓰지 않음', () => {
  // 구간 번호가 첫 구간(1)이면 무시 — 첫 지하철은 rt.first로만
  const first = plan(at(7, 42), { rt: mid([{ etaSec: 600 }], 1) });
  assert.deepEqual([legOf(first, 1).board, legOf(first, 1).src], [468, 'std']);
  // 버스 구간(5)이면 무시
  const bus = plan(at(8, 25), { rt: mid([{ etaSec: 60 }], 5) });
  assert.deepEqual([legOf(bus, 5).board, legOf(bus, 5).src], [517, 'std']);
  // 출발 전(출발 기록 없음): 남아 있는 값이 있어도 무시 — 출발 취소 직후 다음 갱신 전
  const rt = mid([{ etaSec: 2700 }]); // 07:30 기준 08:15
  const a = planTransit({ route: ROUTE, cls: CLS, nowMin: at(7, 30), walkTable: {}, rt });
  const b = planTransit({ route: ROUTE, cls: CLS, nowMin: at(7, 30), walkTable: {}, rt: null });
  assert.deepEqual(a, b);
  assert.equal(legOf(a, 3).src, 'std');
  // simulate만 따로 부르면 쓰임(출발 여부는 planTransit이 정함)
  const sim = simulate(ROUTE, a.pick.departMin, { cls: CLS, nowMin: at(7, 30), rt, walkTable: {} });
  assert.equal(sim.legs.find((l) => l.i === 3).src, 'live');
});

/* ── v2.6.0 구조 · v2.7.0부터 중간 환승 버스도 켬(MID_LIVE_KINDS — 지하철만 고르면 예전과 같음) ── */
// 예시 경로에 중간 버스를 넣은 모양: 2호선 → (중간 버스 7016, 예시) → 1213(마지막 국민대행 버스)
const BUSMID = { ...ROUTE, legs: [L[0], L[1], L[2], { ...L[5], no: '7016', from: { ...L[5].from, name: '시청' }, intervalMin: 8 }, L[4], L[5], L[6]] };
const SUBWAY_ONLY = ['subway'];

test('켠 종류는 지하철 · 버스(v2.7.0) · 환승 구간 고르기는 종류와 상관없이(마지막 국민대행 버스는 rt.final이 맡아 빠짐)', () => {
  assert.deepEqual(MID_LIVE_KINDS, ['subway', 'bus']);
  assert.ok(Object.isFrozen(MID_LIVE_KINDS));
  assert.deepEqual([transferLegs(ROUTE), transferLegs(ROUTE, SUBWAY_ONLY)], [[3], [3]], '예시 경로: 마지막 1213은 빠짐');
  assert.deepEqual([transferLegs(BUSMID), transferLegs(BUSMID, SUBWAY_ONLY), transferSubways(BUSMID)], [[3], [], []], '중간 버스는 버스를 켰을 때만');
  assert.deepEqual(transferLegs(TWO), [3, 5], '버스 → 공항철도 → 4호선 → 163: 첫 버스 · 마지막 버스는 빠짐');
  assert.deepEqual(transferLegs({ legs: [{ kind: 'walk' }, { kind: 'bus' }, { kind: 'walk' }, { kind: 'bus' }, { kind: 'walk' }, { kind: 'subway' }] }), [3, 5], '마지막이 지하철이면 중간 버스 · 마지막 지하철');
});

test('다음 탈 환승 버스 · 부를지(기준 T = 정류장 도착 예상 + 표준 기다림 · ±15분 · 표준값 범위)는 지하철과 같은 규칙 — 지하철만 고르면 부르지 않음', () => {
  const dep = DEP, p = (now, o = {}) => planTransit({ route: BUSMID, cls: CLS, nowMin: now, walkTable: {}, departedMin: dep, ...o });
  const l1 = legOf(p(at(7, 41)), 1), l3 = legOf(p(at(7, 41)), 3);
  const now = l1.board + 1; // 2호선을 탄 뒤
  const h = midHint(p(now), BUSMID, now);
  assert.deepEqual(h, { i: 3, at: l3.arrive });
  assert.equal(midHint(p(now), BUSMID, now, SUBWAY_ONLY), null, '지하철만: 중간 버스는 알려 주지 않음');
  assert.deepEqual(midCheck(BUSMID, p(now), h, now, { kinds: SUBWAY_ONLY }), { ok: false, reason: 'not-transfer', i: 3 }, '지하철만: 서버도 부르지 않음');
  const T = l3.arrive + stdWait(BUSMID.legs[3]); // 배차 8분 → 표준 기다림 5분
  assert.equal(stdWait(BUSMID.legs[3]), 5);
  assert.equal(midCheck(BUSMID, p(now), h, now).reason, 'not-yet', '2호선 타는 중 · 탑승 15분 전보다 이름');
  assert.deepEqual(midCheck(BUSMID, p(T - 15), h, T - 15), { ok: true, i: 3, kind: 'bus', T, S: l3.board, clamped: false });
  assert.equal(midCheck(BUSMID, p(T - 15.1), h, T - 15.1).reason, 'not-yet');
  assert.equal(midCheck(BUSMID, p(T + 15.1), h, T + 15.1).reason, 'passed');
  assert.equal(midCheck(BUSMID, p(now), { i: 3, at: 600 }, now).clamped, true, '표준값 범위 밖이면 표준값');
  assert.equal(midCheck(BUSMID, p(now), { i: 5, at: 511 }, now).reason, 'not-transfer', '마지막 국민대행 버스는 환승 구간이 아님');
});

test('받은 버스로 탈 시각(승강장 시간 없이 정류장 도착 뒤 첫 차 · 버스 번호) · 뒤 구간 다시 계산 — 지하철만 고르면 표준 기다림', () => {
  const p = (now, o = {}) => planTransit({ route: BUSMID, cls: CLS, nowMin: now, walkTable: {}, departedMin: DEP, ...o });
  const l1 = legOf(p(at(7, 41)), 1), l3 = legOf(p(at(7, 41)), 3);
  const now = l1.board + 1;
  const bus = (minsFromNow) => ({ mid: { i: 3, kind: 'bus', source: 'seoul', buses: [{ no: '7016', etasSec: minsFromNow.map((x) => x * 60), termMin: 8, msgs: [] }] } });
  // 정류장 도착 시각 정각에 오는 버스는 탐(지하철처럼 2분을 더하지 않음) · 그보다 이른 버스는 못 탐
  const exact = legOf(p(now, { rt: bus([l3.arrive - now]) }), 3);
  assert.deepEqual([exact.board, exact.src, exact.vehicle], [l3.arrive, 'live', '7016']);
  const early = legOf(p(now, { rt: bus([l3.arrive - now - 0.5, l3.arrive - now + 3]) }), 3);
  assert.deepEqual([early.board, early.src], [l3.arrive + 3, 'live']);
  // 뒤 구간: 버스가 늦으면 마지막 버스 · 강의실 도착이 함께 밀림
  const late = p(now, { rt: bus([l3.arrive - now + 12]) }), std = p(now);
  assert.equal(legOf(late, 3).board, l3.arrive + 12);
  assert.ok(late.pick.classArriveMin > std.pick.classArriveMin);
  // 지하철만 고르면: 같은 값이 와도 쓰지 않음
  const off = legOf(p(now, { rt: bus([l3.arrive - now + 12]), midKinds: SUBWAY_ONLY }), 3);
  assert.deepEqual([off.board, off.src], [l3.board, 'std']);
});
