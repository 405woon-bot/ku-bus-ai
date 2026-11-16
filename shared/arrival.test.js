import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRIVAL, appliedOffset, arrivalFeedback, arrivalKey, arrivalWindow, emptyPersonal, keepArrivals, learnOffset,
  personalLabel, personalOffset, personalText, recordArrival, slackText, undoArrival, verdictOf,
} from './arrival.js';
import { recommend, walkToBuilding } from './recommend.js';
import { itemsOf, parseArrivals, parseStations, computeTrips } from './stopTrips.js';
import { SAMPLE_ARRIVALS, SAMPLE_ROUTE_STATIONS } from './samples/seoulSample.js';
import { WALK_TABLE } from './campusData.js';
import { toMin, toHHMM } from './time.js';

const cls = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const at = (hhmm) => toMin(hhmm);
const learn = (prev, hhmm) => learnOffset(prev, { arriveMin: at(hhmm), startMin: at('09:00') });

test('버튼 시간: 시작 30분 전 ~ 15분 뒤(window) · 그 뒤 끝나기 전까지 수업 중(class) · 끝(after)', () => {
  const ph = (hhmm) => arrivalWindow(cls, at(hhmm)).phase;
  assert.deepEqual(['08:29', '08:30', '09:00', '09:15', '09:16', '10:14', '10:15'].map(ph), ['before', 'window', 'window', 'window', 'class', 'class', 'after']);
  const w = arrivalWindow(cls, at('08:45'));
  assert.deepEqual([w.openMin, w.closeMin, w.endMin, w.canRecord, w.inClass], [at('08:30'), at('09:15'), at('10:15'), true, true]);
  assert.equal(arrivalWindow(cls, at('09:20')).canRecord, false);
  assert.equal(arrivalWindow(cls, at('09:20')).inClass, true);
  assert.equal(arrivalWindow({ ...cls, end: '' }, at('10:14')).endMin, at('10:15'), '끝 시각이 없으면 75분 수업으로');
  assert.equal(arrivalWindow(null, 500), null);
  assert.equal(arrivalWindow({ ...cls, start: 'x' }, 500), null);
});

test('EMA 학습: 늦으면 0.5배로 빠르게(최대 +3) · 5~10분 전은 그대로 · 너무 일찍이면 0.25배로 완만하게(최대 −2)', () => {
  const pick = (r) => [r.offsetMin, r.deltaMin, r.slackMin, r.errorMin, r.verdict];
  assert.deepEqual(pick(learn(0, '08:58')), [1.5, 1.5, 2, 3, 'tight'], '수업 2분 전: 목표보다 3분 늦음 → +1.5');
  assert.deepEqual(pick(learn(0, '08:55')), [0, 0, 5, 0, 'good'], '수업 5분 전 = 목표');
  assert.deepEqual(pick(learn(0, '08:50')), [0, 0, 10, 0, 'good'], '수업 10분 전까지는 딱 좋음(배차 간격 여유)');
  assert.deepEqual(pick(learn(0, '08:45')), [-1.2, -1.2, 15, -5, 'early'], '15분 전: 10분 기준으로 5분 더 일찍 → −1.25(소수 첫째 자리)');
  assert.deepEqual(pick(learn(0, '08:30')), [-2, -2, 30, -20, 'early'], '한 번에 최대 −2');
  assert.deepEqual(pick(learn(0, '09:00')), [2.5, 2.5, 0, 5, 'tight'], '수업 시작 정각: +2.5');
  assert.deepEqual(pick(learn(0, '09:04')), [3, 3, -4, 9, 'late'], '4분 지각 → 한 번에 최대 +3');
  assert.deepEqual(pick(learn(2, '08:57')), [3, 1, 3, 2, 'tight'], '이전 값에 더함');
});

test('안전장치: 전체 −5 ~ +15분, 범위에 닿으면 limited · 이상한 저장값은 0으로', () => {
  assert.deepEqual([learn(14, '09:10').offsetMin, learn(14, '09:10').limited], [15, 'max']);
  assert.deepEqual([learn(15, '09:10').offsetMin, learn(15, '09:10').deltaMin, learn(15, '09:10').limited], [15, 0, 'max']);
  assert.deepEqual([learn(-4, '08:30').offsetMin, learn(-4, '08:30').limited], [-5, 'min']);
  assert.equal(learn('abc', '08:58').prevOffsetMin, 0);
  assert.deepEqual([personalOffset(99), personalOffset(-9), personalOffset(null), personalOffset('2.04')], [15, -5, 0, 2]);
  // 한 번에 얼마나 바뀌든 +3 / −2를 넘지 않음
  for (let m = toMin('08:00'); m <= toMin('09:15'); m += 0.5) {
    const r = learnOffset(0, { arriveMin: m, startMin: at('09:00') });
    assert.ok(r.deltaMin <= ARRIVAL.maxUpMin && r.deltaMin >= -ARRIVAL.maxDownMin, `${m}: ${r.deltaMin}`);
  }
});

test('반복하면 수렴: 매일 3분 늦게 걷는 사람(목표보다 3분 늦음) → +3 근처 · 매일 20분 일찍 오는 사람 → 천천히 −5까지', () => {
  // 실제 도착 = 계획 도착(수업 5분 전 − 보정) + 3분(내 걸음) 이라고 가정
  let off = 0;
  for (let day = 0; day < 8; day++) off = learnOffset(off, { arriveMin: at('08:55') - appliedOffset(off) + 3, startMin: at('09:00') }).offsetMin;
  assert.ok(off >= 2.5 && off <= 3.5, String(off));
  let e = 0; const seen = [];
  for (let day = 0; day < 5; day++) { e = learnOffset(e, { arriveMin: at('08:40'), startMin: at('09:00') }).offsetMin; seen.push(e); }
  assert.deepEqual(seen, [-2, -4, -5, -5, -5]);
});

test('정수로 반영(반올림, 0.5는 일찍 쪽) · 표시 글', () => {
  assert.deepEqual([0.5, 1.4, 1.5, -0.5, -1.5, -0.4].map(appliedOffset), [1, 1, 2, 0, -1, 0]);
  assert.deepEqual([3, -2, 0, 0.4].map(personalLabel), ['+3분', '−2분', '0분', '0분']);
  assert.match(personalText({ offsetMin: 3, samples: 2 }), /3분 더 걸린다고 보고, 3분 일찍 도착하도록/);
  assert.match(personalText({ offsetMin: -2, samples: 4 }), /2분 덜 걸린다고/);
  assert.match(personalText(emptyPersonal()), /아직 도착 기록이 없어요/);
  assert.equal(personalText({ offsetMin: 0.2, samples: 3 }), '지금은 보정 없이 계산해요');
  assert.deepEqual([12.5, 5, 1, 0.4, 0, -0.2, -3].map(slackText), ['수업 12분 전', '수업 5분 전', '수업 1분 전', '수업 시작 직전', '수업 시작 직전', '수업 시작 1분 뒤', '수업 시작 3분 뒤']);
  assert.deepEqual([4.99, 5, 10.9, 11, -0.1].map(verdictOf), ['tight', 'good', 'good', 'early', 'late'], "화면의 '몇 분 전'(내림)과 판정이 맞음");
});

test('도착 기록 · 피드백 문구 · 되돌리기', () => {
  const key = arrivalKey('2026-11-16', cls);
  assert.equal(key, '2026-11-16:c1');
  const { record, personal } = recordArrival({ offsetMin: 1, samples: 2 }, { key, dateKey: '2026-11-16', cls, arriveMin: at('08:58') + 0.4, at: '2026-11-15T23:58:24.000Z' });
  assert.deepEqual([record.key, record.classId, record.name, record.start, record.arriveMin, record.prevOffsetMin, record.offsetMin], [key, 'c1', '자료구조', '09:00', 538.4, 1, 2.7]);
  assert.deepEqual(personal, { offsetMin: 2.7, samples: 3, updatedAt: '2026-11-15T23:58:24.000Z' });
  const fb = arrivalFeedback(record);
  assert.deepEqual(fb, { title: '도착 기록 완료!', when: '08:58 도착 · 수업 1분 전', verdict: '조금 빠듯했어요', change: '다음부터 평소보다 2분 일찍 도착하도록 안내할게요', status: '내 걸음 반영 +3분' });
  // 바뀐 정수가 없으면 '아직은 지금처럼', 딱 좋으면 '지금처럼', 일찍이면 '덜 서둘러도'
  assert.equal(arrivalFeedback(learnAsRecord(0, '08:54')).change, '지금처럼 안내할게요');
  assert.match(arrivalFeedback(learnAsRecord(1.5, '08:55.5')).change, /아직은 지금처럼/);
  assert.equal(arrivalFeedback(learnAsRecord(0, '08:40')).change, '다음부터 2분 덜 서둘러도 되게 안내할게요');
  assert.match(arrivalFeedback(learnAsRecord(15, '09:10')).change, /이미 최대\(\+15분\).*정류장까지 걸어서/);
  assert.match(arrivalFeedback(learnAsRecord(-5, '08:30')).change, /이미 최소\(−5분\)/);
  assert.equal(arrivalFeedback(learnAsRecord(0, '09:04')).when, '09:04 도착 · 수업 시작 4분 뒤');
  // 되돌리기: 마지막 기록만, 이전 보정으로
  const list = [{ key: 'a', prevOffsetMin: 0, offsetMin: 1 }, { key, prevOffsetMin: 1, offsetMin: 2.7 }];
  const u = undoArrival(personal, list, key, 'T');
  assert.deepEqual([u.personal, u.arrivals.length, u.removed.key], [{ offsetMin: 1, samples: 2, updatedAt: 'T' }, 1, key]);
  assert.equal(undoArrival(personal, list, 'a'), null, '마지막이 아니면 못 되돌림');
  assert.equal(undoArrival(personal, [], key), null);
  assert.equal(keepArrivals(Array.from({ length: 25 }, (_, i) => i)).length, ARRIVAL.keep);
});
function learnAsRecord(prev, hhmm) {
  const [h, m] = hhmm.split(':');
  const arriveMin = Number(h) * 60 + Number(m);
  return recordArrival({ offsetMin: prev, samples: 1 }, { key: 'k', dateKey: 'd', cls, arriveMin, at: null }).record;
}

// ── 추천 계산에 반영 ──
const stationsByRoute = Object.fromEntries(Object.entries(SAMPLE_ROUTE_STATIONS).map(([k, v]) => [k, parseStations(itemsOf(v))]));
const tripsAt = (arsId) => computeTrips({ arrivals: parseArrivals(itemsOf(SAMPLE_ARRIVALS[arsId])), stationsByRoute, boardArsId: arsId });

test('추천에 내 걸음 반영: 강의실 도착 예정 = 원래 + 보정 → 넘치면 더 일찍 도착하는 차 · 출발도 앞당김', () => {
  const base = recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE });
  assert.deepEqual([toHHMM(base.pick.boardMin), toHHMM(base.pick.departMin), toHHMM(base.pick.classArriveMin), base.personalMin], ['08:45', '08:40', '08:54', 0]);
  const plus1 = recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE, personalOffsetMin: 1 });
  assert.deepEqual([toHHMM(plus1.pick.departMin), toHHMM(plus1.pick.classArriveMin), plus1.personalMin], ['08:40', '08:55', 1], '+1분: 08:55 도착이라 목표(5분 전) 안 → 같은 차');
  const plus3 = recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE, personalOffsetMin: 2.6 });
  assert.equal(plus3.personalMin, 3);
  assert.ok(plus3.pick.departMin < base.pick.departMin && plus3.pick.classArriveMin <= toMin('08:55'), `${toHHMM(plus3.pick.departMin)} ${toHHMM(plus3.pick.classArriveMin)}`);
  const p = plus3.pick;
  assert.equal(p.classArriveMin, p.boardMin + p.trip.inVehicleMin + walkToBuilding(WALK_TABLE, cls.building, p.trip.gate) + 3, '탑승 + 차내 + 도보 + 내 걸음 3분');
  const minus = recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE, personalOffsetMin: -5 });
  assert.ok(minus.pick.boardMin >= base.pick.boardMin, '빠른 사람은 같은 차이거나 더 늦은 차');
  assert.equal(recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE, personalOffsetMin: 'x' }).personalMin, 0);
  assert.equal(recommend({ trips: tripsAt('S-01'), cls, nowMin: toMin('08:05'), walkTable: WALK_TABLE, personalOffsetMin: 99 }).personalMin, 15);
});
