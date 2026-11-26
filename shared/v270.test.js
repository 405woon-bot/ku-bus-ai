// v2.7.0 환승 버스(공용 계산) 점검: 켠 종류에 버스 · 체험판 예시 경로(2호선 → 150 → 1213) · 다음 탈 환승 버스(출발했어요! 뒤 · 한 곳) · 창(기준 = 정류장 도착 + 표준 기다림) ·
//   서울시 모양(막차 '운행종료'면 잇지 않음) · 경기도 모양(배차로 이어 붙임) · 번호가 여럿이면 먼저 오는 차 · 탄 뒤 고정 · 출발 전에는 쓰지 않음.
//   경로 · 버스는 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_ODSAY_MIDBUS } from './samples/odsaySample.js';
import { MID_LIVE_KINDS, lockPins, midCheck, midHint, parseOdsayResult, planTransit, stdWait, transferLegs } from './transitPlan.js';

const ROUTE = parseOdsayResult(SAMPLE_ODSAY_MIDBUS).paths[0];
const CLS = { id: 'c1', name: '자료구조', day: 0, start: '09:30', end: '10:45', building: '미래관', room: '301' };
const DEP = 7 * 60 + 40;
const at = (h, m) => h * 60 + m;
const plan = (nowMin, o = {}) => planTransit({ route: ROUTE, cls: CLS, nowMin, walkTable: {}, departedMin: DEP, ...o });
const legOf = (p, i) => p.pick.legs.find((l) => l.i === i && l.kind !== 'walk');
const mid = (buses, o = {}) => ({ mid: { i: 3, kind: 'bus', source: 'seoul', region: 'seoul', buses, ...o } });

test('체험판 예시 경로: 2호선 홍대입구 → 환승 버스 150(시청앞.덕수궁 · 배차 6분) → 1213 · 켠 종류는 지하철 · 버스', () => {
  assert.deepEqual(MID_LIVE_KINDS, ['subway', 'bus']);
  assert.equal(ROUTE.title, '2호선 → 150 → 1213');
  const B = ROUTE.legs[3];
  assert.deepEqual([B.kind, B.no, B.from.name, B.from.arsId, B.intervalMin, B.typeLabel], ['bus', '150', '시청앞.덕수궁', '99203', 6, '간선']);
  assert.deepEqual(transferLegs(ROUTE), [3], '마지막 1213은 국민대행 버스(rt.final)');
  assert.equal(stdWait(B), 4);
  const p = plan(at(8, 5));
  assert.deepEqual([legOf(p, 1).board, legOf(p, 1).end, legOf(p, 3).arrive, legOf(p, 3).board, legOf(p, 5).board], [468, 483, 490, 494, 531]);
});

test('다음 탈 환승 버스(화면 → 서버): 2호선을 탄 뒤부터 150 · 창 = 08:14 ± 15분(07:59 ~ 08:29) · 150을 타면 없음', () => {
  assert.equal(midHint(planTransit({ route: ROUTE, cls: CLS, nowMin: at(7, 30), walkTable: {} }), ROUTE, at(7, 30)), null, '출발 전');
  assert.equal(midHint(plan(at(7, 45)), ROUTE, at(7, 45)), null, '2호선 타기 전(첫 구간)');
  for (const now of [at(7, 50), at(8, 5), at(8, 12)]) assert.deepEqual(midHint(plan(now), ROUTE, now), { i: 3, at: 490 }, String(now));
  assert.equal(midHint(plan(at(8, 15)), ROUTE, at(8, 15)), null, '08:14에 탔다고 봄(표준) → 다음은 마지막 버스');
  const std = plan(at(8, 5)), h = { i: 3, at: 490 };
  assert.deepEqual(midCheck(ROUTE, std, h, at(7, 59)), { ok: true, i: 3, kind: 'bus', T: 494, S: 494, clamped: false });
  assert.equal(midCheck(ROUTE, std, h, at(7, 58.9)).reason, 'not-yet');
  assert.equal(midCheck(ROUTE, std, h, at(8, 29)).ok, true);
  assert.equal(midCheck(ROUTE, std, h, at(8, 29.1)).reason, 'passed');
});

test('서울시 모양: 정류장 도착(08:10) 뒤 첫 차 · 막차(둘째 칸 운행종료)면 그 뒤를 잇지 않아 표준 기다림 · 뒤 구간 다시 계산', () => {
  const now = at(8, 5);
  const p = plan(now, { rt: mid([{ no: '150', etasSec: [7 * 60, 13 * 60], termMin: 6, msgs: ['7분후[3번째 전]', '13분후[6번째 전]'] }]) }); // 08:12 · 08:18
  assert.deepEqual([legOf(p, 3).board, legOf(p, 3).src, legOf(p, 3).vehicle, legOf(p, 3).wait], [492, 'live', '150', 2]);
  assert.ok(p.pick.classArriveMin <= plan(now).pick.classArriveMin, '표준(08:14)보다 일찍 타면 같거나 빠름');
  // 08:08 차는 못 탐(도착 08:10) · 막차라 뒤를 잇지 않음 → 표준 기다림
  const last = plan(now, { rt: mid([{ no: '150', etasSec: [3 * 60], termMin: 6, msgs: ['3분후[1번째 전]', '운행종료'] }]) });
  assert.deepEqual([legOf(last, 3).board, legOf(last, 3).src], [494, 'std']);
  // 막차가 아니면 배차간격(6분)으로 이어 붙인 예상(term): 08:08 → 08:14
  const term = plan(now, { rt: mid([{ no: '150', etasSec: [3 * 60], termMin: 6, msgs: ['3분후[1번째 전]', ''] }]) });
  assert.deepEqual([legOf(term, 3).board, legOf(term, 3).src], [494, 'term']);
  // 늦게 오는 차 → 마지막 버스 · 강의실 도착이 함께 밀림
  const late = plan(now, { rt: mid([{ no: '150', etasSec: [15 * 60], termMin: 6, msgs: ['15분후', ''] }]) }); // 08:20
  assert.deepEqual([legOf(late, 3).board, legOf(late, 5).arrive], [500, 531]);
  assert.ok(late.pick.classArriveMin > plan(now).pick.classArriveMin);
});

test('경기도 모양(배차로 이어 붙임) · 한 구간에 번호가 여럿이면 먼저 오는 차(버스 번호) · 탄 뒤에는 그 값으로 고정', () => {
  const now = at(8, 5);
  const gg = plan(now, { rt: mid([{ no: '150', etasSec: [60], termMin: 6, msgs: [] }], { source: 'gyeonggi', region: 'gyeonggi' }) }); // 08:06 → +6 08:12
  assert.deepEqual([legOf(gg, 3).board, legOf(gg, 3).src], [492, 'term']);
  const multi = plan(now, { rt: mid([{ no: '150', etasSec: [11 * 60], termMin: 6, msgs: ['', ''] }, { no: '402', etasSec: [8 * 60], termMin: 7, msgs: ['', ''] }]) });
  assert.deepEqual([legOf(multi, 3).board, legOf(multi, 3).vehicle], [493, '402']);
  // 08:12:30 실시간 차로 탈 시각 → 30초 안이라 고정 → 다음 갱신에 값이 없어도 그대로
  const p = plan(at(8, 12), { rt: mid([{ no: '150', etasSec: [30], termMin: 6, msgs: ['곧 도착', ''] }]) });
  const pins = lockPins(p, at(8, 12));
  assert.deepEqual(pins[3], { board: 492.5, ride: 26, src: 'live', vehicle: '150', approx: false });
  const later = legOf(plan(at(8, 20), { pins }), 3);
  assert.deepEqual([later.board, later.src, later.pinned], [492.5, 'live', true]);
});

test('출발 전(출발 기록 없음)에는 남은 환승 버스 값을 쓰지 않음 · 마지막 국민대행 버스를 가리키는 값은 무시', () => {
  const rt = mid([{ no: '150', etasSec: [40 * 60], termMin: 6, msgs: ['', ''] }]);
  const a = planTransit({ route: ROUTE, cls: CLS, nowMin: at(7, 30), walkTable: {}, rt });
  const b = planTransit({ route: ROUTE, cls: CLS, nowMin: at(7, 30), walkTable: {}, rt: null });
  assert.deepEqual(a, b);
  const fin = plan(at(8, 25), { rt: { mid: { i: 5, kind: 'bus', source: 'seoul', buses: [{ no: '1213', etasSec: [60], termMin: 9, msgs: ['', ''] }] } } });
  assert.equal(legOf(fin, 5).src, 'std', '마지막 버스는 rt.final만');
});
