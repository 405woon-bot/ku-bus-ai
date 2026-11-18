// v2.1 공통 계산 점검: 경로 못 찾을 때 문구(직행을 미리 약속하지 않음) · 예전 경로 문구 · 버스 구간 경유 정류장 좌표 ·
// 환승 '왜 늦나요?'(계산이 고른 마지막 국민대행 버스 · 첫 지하철 열차 간격) · 미리 찾을 기본 역 목록
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEARBY_REASONS, TRANSIT, busPath, fallbackText, finalTripOf, parseOdsayResult, planTransit, staleText, subwayGap } from './transitPlan.js';
import { WARM_ORIGINS } from './warmOrigins.js';
import { WALK_TABLE } from './campusData.js';
import { toMin, toHHMM } from './time.js';
import { SAMPLE_ODSAY_RESPONSE } from './samples/odsaySample.js';

const cls = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const A = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0]; // 걸어서 → 2호선(배차 5분) → 4호선 → 1213 → 걸어서
const W = WALK_TABLE['미래관']['정문'];

test('경로를 못 찾을 때 문구: 직행 안내를 미리 약속하지 않음 · 근처 정류장을 찾아볼 이유 · 예전 경로 문구', () => {
  for (const r of ['cap', 'no-key', 'no-path', 'auth', 'error', 'near']) assert.ok(!/직행/.test(fallbackText(r, 25)), r);
  assert.equal(fallbackText('cap', 25), '오늘 새 경로 검색 한도(25회)를 다 썼어요. 이 출발지는 내일부터 찾을 수 있어요');
  assert.deepEqual([...NEARBY_REASONS].sort(), ['auth', 'cap', 'error', 'no-key', 'no-path', 'store']);
  assert.ok(!NEARBY_REASONS.includes('near') && !NEARBY_REASONS.includes('bad') && !NEARBY_REASONS.includes('out-of-area'));
  assert.equal(staleText('cap', 41, 25), '오늘 새 경로 검색 한도(25회)를 다 써서, 41일 전에 찾아 둔 경로를 보여 드려요');
  assert.match(staleText('error', 33), /ODsay에서 새 경로를 받지 못해서, 33일 전에/);
});

test('버스 구간 경유 정류장 좌표(ODsay passStopList x · y): 위도 · 경도 · 이름, 좌표 없는 정류장은 빼고 길면 고르게 줄임', () => {
  const bus = A.legs[5];
  assert.equal(bus.kind, 'bus');
  assert.ok(bus.path.length >= 2 && bus.path.every((p) => p.lat > 37 && p.lat < 38 && p.lon > 126 && p.lon < 128 && p.name));
  assert.equal(A.legs[1].path, undefined, '지하철 구간은 도로가 아니라 좌표를 싣지 않음');
  const many = Array.from({ length: 150 }, (_, i) => ({ stationName: `정류장${i}`, x: String(127 + i / 1e4), y: String(37.5 + i / 1e4) }));
  const p = busPath([...many, { stationName: '좌표없음', x: '0', y: '0' }, { stationName: '이상함', x: 'abc' }]);
  assert.equal(p.length, TRANSIT.pathMaxPoints);
  assert.deepEqual([p[0].name, p[p.length - 1].name], ['정류장0', '정류장149'], '처음 · 끝은 남김');
  assert.deepEqual(busPath(null), []);
});

test("환승 '왜 늦나요?' 마지막 버스: 계산이 고른 국민대행 차의 서버 값(혼잡 · 설명) — 표준 대기로 계산하면 없음", () => {
  const nowMin = toMin('08:00');
  const explain = { source: 'gemini', text: '정릉로가 막혀요.' };
  const trips = [{ no: '1213', etasSec: [20 * 60, 29 * 60], termMin: 9, inVehicleMin: 16, gate: '정문', msgs: [], congestion: 'heavy', delayMin: 6, explain },
    { no: '110B', etasSec: [3 * 60], termMin: 12, inVehicleMin: 9, gate: '정문', msgs: [], congestion: 'smooth' }];
  const rt = { final: { i: 5, source: 'seoul', trips } };
  const plan = planTransit({ route: A, cls: { ...cls, start: '11:00' }, nowMin, rt, walkTable: WALK_TABLE });
  const t = finalTripOf(A, plan, rt);
  const bus = plan.pick.legs.find((l) => l.kind === 'bus');
  assert.ok(['1213', '110B'].includes(bus.vehicle) && bus.src !== 'std');
  assert.equal(t, trips.find((x) => x.no === bus.vehicle), '계산이 고른 바로 그 차(서버가 붙인 값 그대로)');
  // 1213만 오면 그 차의 혼잡 · 지연 분 · 설명
  const rt2 = { final: { i: 5, source: 'seoul', trips: [trips[0]] } };
  const t2 = finalTripOf(A, planTransit({ route: A, cls: { ...cls, start: '11:00' }, nowMin, rt: rt2, walkTable: WALK_TABLE }), rt2);
  assert.deepEqual([t2.no, t2.congestion, t2.delayMin, t2.explain.text], ['1213', 'heavy', 6, '정릉로가 막혀요.']);
  const std = planTransit({ route: A, cls, nowMin: toMin('07:00'), walkTable: WALK_TABLE });
  assert.equal(finalTripOf(A, std, null), null);
  assert.equal(finalTripOf(A, { state: 'started' }, rt), null);
});

test('첫 지하철 간격: 내가 탈 열차 바로 앞 간격이 배차간격(5분)보다 3분 이상 길 때만 · 어림 열차 · 실시간 아님이면 없음', () => {
  const N = toMin('08:55') - 76 - W - 1; // 이 시각에 N+12 열차가 마지막으로 되는 열차(shared/transitPlan.test.js와 같은 설정)
  const plan = (trains, source = 'seoul') => {
    const rt = { first: { i: 1, kind: 'subway', source, trains } };
    return [planTransit({ route: A, cls, nowMin: N, rt, walkTable: WALK_TABLE }), rt];
  };
  // 열차 N+5 · N+12: 내 열차(N+12) 앞 간격 7분 = 배차 5분 + 2 → 아직 아님
  let [p, rt] = plan([{ etaSec: 300 }, { etaSec: 720 }]);
  assert.equal(p.pick.legs.find((l) => l.kind === 'subway').board, N + 12);
  assert.equal(subwayGap(A, p, rt, N), null);
  // 지금부터 12분 동안 열차가 없음(N+12가 첫 열차) → 12 − 5 = 7분 더
  [p, rt] = plan([{ etaSec: 720 }, { etaSec: 1080 }]);
  const g = subwayGap(A, p, rt, N);
  assert.deepEqual([g.line, g.station, g.gapMin, g.intervalMin, g.extraMin, g.sample], ['2호선', '홍대입구역', 12, 5, 7, false]);
  assert.equal(g.text, '홍대입구역 2호선 열차 간격이 평소보다 길어요.');
  // 미리보기 예시 열차는 sample 표시
  assert.equal(subwayGap(A, ...plan([{ etaSec: 720 }], 'sample'), N).sample, true);
  // 도착 문구로 어림한 열차(approx)는 시각이 정확하지 않아 쓰지 않음 · 실시간 전(skip)도 없음
  assert.equal(subwayGap(A, ...plan([{ etaSec: 720, approx: true }]), N), null);
  assert.equal(subwayGap(A, ...plan([{ etaSec: 720 }], 'skip'), N), null);
  assert.equal(subwayGap(A, { state: 'no-class' }, rt, N), null);
});

test('밤에 미리 찾을 기본 목록: 서울 주요 환승역 46곳 · 모두 ○○역 · 겹침 없음', () => {
  assert.equal(WARM_ORIGINS.length, 46);
  assert.ok(WARM_ORIGINS.every((n) => /역$/.test(n)));
  assert.equal(new Set(WARM_ORIGINS).size, WARM_ORIGINS.length);
  assert.ok(['건대입구역', '왕십리역', '청량리역', '길음역', '홍대입구역'].every((n) => WARM_ORIGINS.includes(n)));
  assert.equal(toHHMM(toMin('21:00')), '21:00');
});
