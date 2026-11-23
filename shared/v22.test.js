// v2.2 '출발했어요!' 계산 점검: 누른 시각 고정 · 지난 구간 · 이미 탔음 고정(pins) · 수업 시작 뒤 · 버튼 시간 · 진행 표시 · 경로 표
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDepart, departProgress, hhmm, lockPins, planTransit, routeKey, TRANSIT, wantsLive } from './transitPlan.js';
import { WALK_TABLE } from './campusData.js';

// 풍무역 → 김포골드라인 → 김포공항역 → 공항철도 → 홍대입구역 → 간선 163(동교동삼거리) → 국민대앞 (예시 경로)
const ROUTE = {
  id: 'p0', title: '김포골드라인 → 공항철도 → 163', transfers: 2, payment: 2050, legs: [
    { kind: 'walk', min: 1 },
    { kind: 'subway', min: 10, intervalMin: 4, line: '김포골드라인', color: '#A17800', from: { name: '풍무' }, to: { name: '김포공항' }, stops: 2 },
    { kind: 'walk', min: 4 },
    { kind: 'subway', min: 14, intervalMin: 8, line: '공항철도', subwayId: '1065', color: '#0090D2', from: { name: '김포공항' }, to: { name: '홍대입구' }, stops: 3 },
    { kind: 'walk', min: 2 },
    { kind: 'bus', min: 26, intervalMin: 8, no: '163', buses: ['163', '110A'], typeLabel: '간선', color: '#2F64D6', from: { name: '동교동삼거리연희동방면', arsId: '14001' }, to: { name: '국민대앞' }, stops: 23 },
  ],
};
const CLS13 = { id: 'c1', name: '전자기학', start: '13:00', end: '14:15', building: '미래관' };
const CLS12 = { ...CLS13, start: '12:00', end: '13:15' };
const m = (s) => { const [h, mm] = s.split(':').map(Number); return h * 60 + mm; };
/** 마지막 국민대행 버스 실시간(서울시 모양): 지금 기준 다음 두 대 + 배차 9분 */
const finalRt = (nowMin, times) => ({ final: { i: 5, source: 'seoul', trips: [{ no: '163', etasSec: times.map((x) => (m(x) - nowMin) * 60), termMin: 9, inVehicleMin: 24, gate: '정문', msgs: [] }] } });
const plan = (o) => planTransit({ route: ROUTE, walkTable: WALK_TABLE, marginMin: 5, ...o });
const leg = (p, i) => p.pick.legs.find((l) => l.i === i && l.kind !== 'walk');

test('누르기 전: 지금과 같음 — 추천 출발 · 늦으면 지금 출발 · 수업 시작 뒤에는 started', () => {
  const a = plan({ cls: CLS13, nowMin: m('11:30'), rt: finalRt(m('11:30'), ['11:36', '11:45']) });
  assert.deepEqual([hhmm(a.pick.departMin), hhmm(a.pick.classArriveMin), a.status, a.departNow, a.departed], ['11:36', '12:49', 'relaxed', false, undefined]);
  const late = plan({ cls: CLS12, nowMin: m('11:45'), rt: finalRt(m('11:45'), ['11:51', '12:00']) });
  assert.deepEqual([hhmm(late.pick.departMin), late.departNow, late.status], ['11:45', true, 'late']);
  assert.equal(plan({ cls: CLS12, nowMin: m('12:05') }).state, 'started');
});

test('누른 뒤: 출발 시각이 누른 시각으로 고정 — 시간이 지나도 지금 출발로 밀리지 않음', () => {
  const D = m('11:33');
  const at45 = plan({ cls: CLS13, nowMin: m('11:45'), rt: finalRt(m('11:45'), ['11:51', '12:00']), departedMin: D });
  assert.deepEqual([at45.departed, at45.departedMin, at45.departNow, hhmm(at45.pick.departMin)], [true, D, false, '11:33']);
  assert.deepEqual([hhmm(leg(at45, 1).board), hhmm(leg(at45, 3).board), hhmm(leg(at45, 5).arrive)], ['11:37', '11:59', '12:18'], '김포골드 · 공항철도 · 동교동삼거리 도착');
  assert.deepEqual([leg(at45, 5).src, hhmm(leg(at45, 5).board), hhmm(at45.pick.classArriveMin)], ['term', '12:18', '12:46'], '아직 실시간 범위 밖 → 배차 간격 예상');
  // 12:08: 동교동삼거리 도착(12:18)이 실시간 두 대 안에 들어옴 → 실시간
  const pins = lockPins(at45, m('11:45'), null);
  const at08 = plan({ cls: CLS13, nowMin: m('12:08'), rt: finalRt(m('12:08'), ['12:12', '12:21']), departedMin: D, pins });
  assert.deepEqual([leg(at08, 5).src, hhmm(leg(at08, 5).board), hhmm(at08.pick.classArriveMin), at08.status], ['live', '12:21', '12:49', 'relaxed']);
  assert.equal(hhmm(leg(at08, 5).arrive), '12:18', '동교동삼거리 도착 예상은 그대로(밀리지 않음)');
});

test('지난 구간: 고정값이 없어도 이미 탔을 시각이 지났으면 실시간의 다음 차를 붙이지 않음', () => {
  // 12:30: 동교동삼거리 12:18 도착 + 표준 대기 5분 = 12:23에 탔다고 봄 → 실시간 12:33 차를 붙이면 안 됨
  const p = plan({ cls: CLS13, nowMin: m('12:30'), rt: finalRt(m('12:30'), ['12:33', '12:42']), departedMin: m('11:33') });
  assert.deepEqual([leg(p, 5).src, hhmm(leg(p, 5).board)], ['std', '12:23']);
});

test('이미 탔음 고정(pins): 탈 시각 30초 전부터 그때 값으로 · 실시간이 바뀌어도 그대로 · 바뀐 게 없으면 같은 객체', () => {
  const D = m('11:33'), now = m('12:20') + 0.6; // 12:20:36
  // 마지막 버스 12:21(실시간)이 30초 안 → 고정. 앞의 두 구간은 이미 지나 표준 대기 값으로 고정
  const p1 = plan({ cls: CLS13, nowMin: now, rt: { final: { ...finalRt(now, []).final, trips: [{ no: '163', etasSec: [(m('12:21') - now) * 60, (m('12:30') - now) * 60], termMin: 9, inVehicleMin: 24, gate: '정문', msgs: [] }] } }, departedMin: D });
  const pins = lockPins(p1, now, null);
  assert.deepEqual(Object.keys(pins).sort(), ['1', '3', '5']);
  assert.deepEqual([pins[5].src, hhmm(pins[5].board), pins[5].ride, pins[5].byTrip, pins[5].gate], ['live', '12:21', 24, true, '정문']);
  assert.deepEqual([pins[1].src, hhmm(pins[1].board), pins[3].src, hhmm(pins[3].board)], ['std', '11:37', 'std', '11:59']);
  assert.equal(lockPins(p1, now, pins), pins, '새로 고정할 구간이 없으면 그대로');
  // 12:25: 실시간 목록에서 12:21 차는 빠지고 12:30 · 12:39만 → 고정값(12:21 탑승) 그대로
  const p2 = plan({ cls: CLS13, nowMin: m('12:25'), rt: finalRt(m('12:25'), ['12:30', '12:39']), departedMin: D, pins });
  assert.deepEqual([hhmm(leg(p2, 5).board), leg(p2, 5).pinned, hhmm(p2.pick.classArriveMin)], ['12:21', true, '12:49']);
  assert.deepEqual([p2.pick.gate, p2.pick.walkInMin], ['정문', WALK_TABLE['미래관']['정문']], '하차 문 · 도보도 그때와 같게');
  // 고정값이 잘못된 모양이면 무시(기기 저장값이 깨져도 계산은 계속)
  const p3 = plan({ cls: CLS13, nowMin: m('12:25'), rt: null, departedMin: D, pins: { 5: { board: 'x' } } });
  assert.equal(leg(p3, 5).pinned, undefined);
});

test('수업이 시작된 뒤: 출발한 날은 도착 예정까지 ok(지각 위험) · 도착 예정이 지나면 started', () => {
  const D = m('11:45');
  const p = plan({ cls: CLS12, nowMin: m('12:20'), rt: finalRt(m('12:20'), ['12:26', '12:35']), departedMin: D });
  assert.deepEqual([p.state, p.status, p.departed, leg(p, 5).src, hhmm(leg(p, 5).board)], ['ok', 'late', true, 'live', '12:35']);
  assert.ok(p.slackMin < 0);
  assert.equal(plan({ cls: CLS12, nowMin: m('13:20'), departedMin: D }).state, 'started', '도착 예정(13시 무렵)이 지남');
  assert.equal(plan({ cls: CLS12, nowMin: m('12:20') }).state, 'started', '누르지 않았으면 지금처럼');
});

test('[출발했어요!] 버튼 시간: 추천 출발 1시간 전부터 · 지금 출발이면 바로 · 누른 뒤 · 수업 시작 뒤 · 수업 없음이면 안 보임', () => {
  assert.equal(TRANSIT.departBeforeMin, 60);
  const p = plan({ cls: CLS13, nowMin: m('10:30'), rt: null });
  const dep = p.pick.departMin; // 표준 대기 기준 추천 출발
  assert.equal(canDepart(p, dep - 61), false);
  assert.equal(canDepart(p, dep - 60), true);
  assert.equal(canDepart(plan({ cls: CLS12, nowMin: m('11:45') }), m('11:45')), true, '지금 출발(늦은 날)');
  assert.equal(canDepart(plan({ cls: CLS13, nowMin: m('11:45'), departedMin: m('11:33') }), m('11:45')), false, '이미 누름');
  assert.equal(canDepart(plan({ cls: CLS12, nowMin: m('12:01') }), m('12:01')), false, '수업 시작 뒤');
  assert.equal(canDepart(plan({ cls: null, nowMin: m('11:00') }), m('11:00')), false);
});

test('진행 표시: 지남 · 타는 중 · 다음 · 그 뒤 — 다 타면 다음 없음', () => {
  const D = m('11:33');
  const p = plan({ cls: CLS13, nowMin: m('11:45'), rt: null, departedMin: D });
  const a = departProgress(p, m('11:45'));
  assert.deepEqual(a.byLeg, { 1: 'riding', 3: 'next', 5: 'later' });
  assert.deepEqual([a.next.i, hhmm(a.next.board), a.last.i], [3, '11:59', 5]);
  const b = departProgress(p, m('12:05'));
  assert.deepEqual(b.byLeg, { 1: 'done', 3: 'riding', 5: 'next' });
  const c = departProgress(p, m('12:40'));
  assert.deepEqual([c.byLeg[5], c.next], ['riding', null]);
  assert.equal(departProgress(plan({ cls: CLS13, nowMin: m('11:30') }), m('11:30')), null, '누르기 전에는 없음');
});

test('경로 표(routeKey): 같은 경로는 같은 값 · 노선이나 타는 곳이 다르면 다른 값 · 경로 없음은 빈 값', () => {
  const k = routeKey(ROUTE);
  assert.equal(k, '김포골드라인@풍무>공항철도@김포공항>163@동교동삼거리연희동방면#6');
  assert.equal(routeKey(JSON.parse(JSON.stringify(ROUTE))), k);
  const other = { ...ROUTE, legs: ROUTE.legs.map((l, i) => (i === 5 ? { ...l, no: '110A' } : l)) };
  assert.notEqual(routeKey(other), k);
  assert.equal(routeKey(null), '');
});

test('지하철 실시간 시간대(wantsLive)도 누른 시각 기준', () => {
  const D = m('11:33');
  const p = plan({ cls: CLS13, nowMin: m('11:40'), departedMin: D });
  assert.equal(wantsLive(p, m('11:40')), true);
  const q = plan({ cls: CLS13, nowMin: m('12:00'), departedMin: D });
  assert.equal(wantsLive(q, m('12:00')), false, '출발 20분 뒤가 지나면 첫 지하철 실시간은 그만');
});
