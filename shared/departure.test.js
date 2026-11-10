import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, decideAlarms, walkMinutes, routeStatus } from './departure.js';
import { WALK_TABLE } from './campusData.js';
import { toMin } from './time.js';

const cls = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };

test('요구사항 예시 문구를 그대로 만든다', () => {
  const plan = buildPlan({ cls, primaryId: '171', walkTable: WALK_TABLE, cause: '정릉로', routes: [
    { id: '171', no: '171', gate: '정문', usualMin: 31, liveMin: 39 },
    { id: '1112', no: '1112', gate: '후문', usualMin: 33, liveMin: 33 },
  ] });
  assert.equal(plan.message, '현재 정릉로 정체로 171번 8분 지연! 8:12까지 출발을 권장합니다. (대체 추천: 후문 방향 1112번 탑승 시 정시 출발 가능)');
  assert.equal(plan.recommendedDepartMin, toMin('08:12'));
  assert.equal(plan.alt.route.no, '1112');
  assert.equal(plan.alt.onTime, true);
});

test('권장 출발 = 수업 − (실시간 버스 + 도보 + 여유 5분), 목표 도착 = 수업 − 도보 − 여유', () => {
  const plan = buildPlan({ cls, primaryId: '171', walkTable: WALK_TABLE, routes: [{ id: '171', no: '171', gate: '정문', usualMin: 12, liveMin: 20 }] });
  assert.equal(plan.recommendedDepartMin, toMin('08:31'));   // 9:00 − (20 + 4 + 5)
  assert.equal(plan.targetArrivalMin, toMin('08:51'));       // 9:00 − 4 − 5
  assert.equal(plan.alarmAtMin, toMin('08:21'));             // 10분 전
  assert.equal(plan.primary.status.label, '+8분 지연');
});

test('도보시간 지정 데이터가 없으면 기본 5분', () => {
  assert.equal(walkMinutes(WALK_TABLE, '없는관', '정문'), 5);
  assert.equal(walkMinutes(WALK_TABLE, '미래관', '후문'), 2);
  const plan = buildPlan({ cls: { ...cls, building: '임시강의동' }, primaryId: 'x', walkTable: WALK_TABLE, routes: [{ id: 'x', no: '7211', gate: '정문', usualMin: 10, liveMin: 10 }] });
  assert.equal(plan.primary.walkMin, 5);
  assert.equal(plan.recommendedDepartMin, toMin('08:40'));
  assert.match(plan.message, /평소대로/);
});

test('대체 노선이 정시 출발은 못 해도 더 늦게 출발할 수 있으면 여유 시간을 안내', () => {
  const plan = buildPlan({ cls, primaryId: '171', walkTable: WALK_TABLE, cause: '정릉로', routes: [
    { id: '171', no: '171', gate: '정문', usualMin: 12, liveMin: 20 },
    { id: '1112', no: '1112', gate: '후문', usualMin: 13, liveMin: 16 },
  ] });
  assert.equal(plan.alt.onTime, false);
  assert.match(plan.message, /1112번 탑승 시 8:37 출발, 6분 여유/);
});

test('상태 칩', () => {
  assert.equal(routeStatus(0).label, '원활');
  assert.equal(routeStatus(1).label, '원활');
  assert.equal(routeStatus(3).level, 'warn');
  assert.equal(routeStatus(8).level, 'danger');
});

test('알림 판정: 조기 지연 경고 → 출발 10분 전 → 지연 악화 → 수업 시작 후 없음', () => {
  const mk = (live) => buildPlan({ cls, primaryId: '171', walkTable: WALK_TABLE, cause: '정릉로', routes: [{ id: '171', no: '171', gate: '정문', usualMin: 12, liveMin: live }] });
  const plan = mk(20);
  assert.deepEqual(decideAlarms({ plan, nowMin: toMin('07:40') }).map((a) => a.type), []);          // 경고 창(08:21−30분=07:51) 전
  assert.deepEqual(decideAlarms({ plan, nowMin: toMin('08:00') }).map((a) => a.type), ['delay']);
  const fired = { delay: { delayMin: 8 } };
  assert.deepEqual(decideAlarms({ plan, nowMin: toMin('08:15'), fired }).map((a) => a.type), []);
  const at = decideAlarms({ plan, nowMin: toMin('08:21'), fired });
  assert.deepEqual(at.map((a) => a.type), ['depart']);
  assert.equal(at[0].title, '10분 뒤 출발하세요 (08:31)');
  const worse = decideAlarms({ plan: mk(23), nowMin: toMin('08:20'), fired: { ...fired, depart: {} } });
  assert.deepEqual(worse.map((a) => a.type), ['worse']);
  const late = decideAlarms({ plan, nowMin: toMin('08:40'), fired });
  assert.equal(late[0].title, '권장 출발 시각(08:31)이 지났어요');
  assert.deepEqual(decideAlarms({ plan, nowMin: toMin('09:00') }), []);
});

test('causeFor: 주 노선의 원인 → 전체 원인 순서(백엔드 planner·화면 App이 같은 함수)', async () => {
  const { causeFor } = await import('./departure.js');
  const live = { cause: '정릉로9길', routes: [{ id: '171', cause: '정릉로' }, { id: '1112', cause: null }] };
  assert.equal(causeFor(live, '171'), '정릉로');
  assert.equal(causeFor(live, '1112'), '정릉로9길');
  assert.equal(causeFor({ routes: [] }, 'x'), null);
});
