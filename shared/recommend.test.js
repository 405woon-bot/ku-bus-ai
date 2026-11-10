import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, decideAlarms, busTimes } from './recommend.js';
import { itemsOf, parseArrivals, parseStations, computeTrips } from './stopTrips.js';
import { SAMPLE_ARRIVALS, SAMPLE_ROUTE_STATIONS } from './samples/seoulSample.js';
import { WALK_TABLE } from './campusData.js';
import { toMin, toHHMM } from './time.js';

const stationsByRoute = Object.fromEntries(Object.entries(SAMPLE_ROUTE_STATIONS).map(([k, v]) => [k, parseStations(itemsOf(v))]));
const tripsAt = (arsId) => computeTrips({ arrivals: parseArrivals(itemsOf(SAMPLE_ARRIVALS[arsId])), stationsByRoute, boardArsId: arsId });
const cls = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };

test('실시간 2대 + 배차간격 예상 차', () => {
  const t = { etasSec: [240, 780], termMin: 9 };
  assert.deepEqual(busTimes(t, toMin('08:05'), toMin('09:00')).map((b) => toHHMM(b.boardMin)), ['08:09', '08:18', '08:27', '08:36', '08:45', '08:54']);
});

test('08:05 고려대부고: 늦지 않는 차 중 가장 늦게 타도 되는 171번 08:45 → 08:40 출발, 08:54 강의실 도착(여유)', () => {
  const r = recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE });
  assert.equal(r.state, 'ok');
  assert.equal(r.pick.trip.no, '171');
  assert.equal(toHHMM(r.pick.boardMin), '08:45');
  assert.equal(toHHMM(r.pick.departMin), '08:40');
  assert.equal(toHHMM(r.pick.classArriveMin), '08:54');
  assert.equal(r.status, 'relaxed');
  assert.deepEqual([r.nextBus.no, r.nextBus.inMin, r.nextBus.isPick, r.nextBus.congestion], ['171', 4, false, 'heavy']);
});

test('수업 직전엔 가장 빨리 도착하는 차와 빠듯/지각 위험 상태', () => {
  const r = recommend({ trips: tripsAt('S-01'), cls: { ...cls, start: '08:15' }, nowMin: toMin('08:05'), walkTable: WALK_TABLE, walkToStopMin: 0 });
  // 171번 08:09 탑승 → 08:09 + 4.8 + 4 = 08:17.8 → 지각 위험 / 1112번 08:12 → 08:16 (더 빠름)
  assert.equal(r.pick.trip.no, '1112'); assert.equal(r.status, 'late');
});

test('알림: 출발 10분 전 1회, 출발 시각이 앞당겨지면 다시, 지각 위험이면 알림', () => {
  // 08:05에 받은 응답으로 계산한 추천(08:40 출발)을 08:30·08:31 시점에 판정
  const r = recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE });
  assert.equal(toHHMM(r.pick.departMin), '08:40');
  assert.deepEqual(decideAlarms({ rec: r, nowMin: toMin('08:29') }), []);
  const a = decideAlarms({ rec: r, nowMin: toMin('08:30') });
  assert.deepEqual(a.map((x) => x.type), ['depart']);
  assert.equal(a[0].title, '10분 뒤 출발하세요 (08:40)');
  assert.deepEqual(decideAlarms({ rec: r, nowMin: toMin('08:31'), fired: { depart: { departMin: r.pick.departMin } } }), []);
  const earlier = decideAlarms({ rec: r, nowMin: toMin('08:31'), fired: { depart: { departMin: r.pick.departMin + 4 } } });
  assert.deepEqual(earlier.map((x) => x.type), ['earlier']);
  const late = recommend({ trips: tripsAt('S-01'), cls: { ...cls, start: '08:15' }, nowMin: toMin('08:05'), walkTable: WALK_TABLE, walkToStopMin: 0 });
  assert.ok(decideAlarms({ rec: late, nowMin: toMin('08:05') }).some((x) => x.type === 'risk'));
});

test('수업 없음 / 이미 시작 / 국민대행 노선 없음', () => {
  assert.equal(recommend({ trips: [], cls: null, nowMin: 500 }).state, 'no-class');
  assert.equal(recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('09:01') }).state, 'started');
  assert.equal(recommend({ trips: [], cls, nowMin: toMin('08:00') }).state, 'no-trip');
});
