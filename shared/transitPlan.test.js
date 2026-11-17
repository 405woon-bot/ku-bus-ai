import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_COLOR, TRANSIT, busColor, distanceM, durationText, firstBoard, inkOn, legEnds, odsayError, parseOdsayResult, planTransit,
  routeSummary, simulate, stdWait, subwayLine, subwayStationName, wantsLive, KOOKMIN_GATE,
} from './transitPlan.js';
import { exampleSubwayJson, parseSubwayArrivals, parseSubwayRow, stationKey, subwayStatus, trainsForLeg } from './subwayArrivals.js';
import { decideAlarms } from './recommend.js';
import { WALK_TABLE } from './campusData.js';
import { toMin, toHHMM } from './time.js';
import { SAMPLE_ODSAY_RESPONSE, SAMPLE_ODSAY_ORIGIN } from './samples/odsaySample.js';

const cls = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const paths = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths;
const A = paths[0]; // 걸어서 → 2호선 → 4호선 → 1213 → 걸어서
const W = WALK_TABLE['미래관']['정문']; // 정문 → 미래관 도보

test('ODsay 응답 해석: 경로 3개(최대) · 구간 종류 · 노선 · 방면(다음 역) · 버스 정류장 번호(하이픈 뺌) · 환승 수', () => {
  assert.equal(paths.length, 3);
  assert.deepEqual(paths.map((p) => [p.title, p.transfers, p.totalMin, p.payment]), [['2호선 → 4호선 → 1213', 2, 52, 1500], ['272 → 4호선 → 1213', 2, 60, 1500], ['2호선 → 4호선', 1, 56, 1400]]);
  assert.deepEqual(A.legs.map((l) => l.kind), ['walk', 'subway', 'walk', 'subway', 'walk', 'bus', 'walk']);
  const [s2, s4, b] = [A.legs[1], A.legs[3], A.legs[5]];
  assert.deepEqual([s2.line, s2.subwayId, s2.color, s2.next, s2.stations.length, s2.intervalMin, s2.from.name], ['2호선', '1002', '#00A84D', '신촌', 10, 5, '홍대입구']);
  assert.deepEqual([s4.line, s4.subwayId, s4.next, s4.wayCode], ['4호선', '1004', '동대문', 1]);
  assert.deepEqual([b.no, b.typeLabel, b.color, b.from.arsId, b.to.arsId, b.from.name, b.intervalMin], ['1213', '지선', MODE_COLOR.green, '99101', '99102', '길음역', 9]);
  assert.equal(paths[1].legs[1].typeLabel, '간선');
  assert.deepEqual(legEnds(A), { first: 1, last: 5 });
  assert.equal(subwayStationName(s2), '홍대입구');
});

test('ODsay 오류: HTTP 200에 error가 목록(message) 또는 객체(msg)로 옴 · 형식이 다르면 format', () => {
  assert.deepEqual(odsayError({ error: [{ code: '500', message: '[ApiKeyAuthFailed] ApiKey authentication failed.' }] }), { code: '500', message: '[ApiKeyAuthFailed] ApiKey authentication failed.' });
  assert.deepEqual(odsayError({ error: { code: '-98', msg: '출발지와 도착지가 너무 가깝습니다.' } }), { code: '-98', message: '출발지와 도착지가 너무 가깝습니다.' });
  assert.equal(odsayError({ result: {} }), null);
  assert.equal(parseOdsayResult({ error: { code: '-99', msg: '검색결과가 없습니다.' } }).error.code, '-99');
  assert.equal(parseOdsayResult({ result: { nothing: 1 } }).error.code, 'format');
  // 도시간(기차 등 trafficType 4~) 경로는 빼고, 쓸 경로가 없으면 -99
  assert.equal(parseOdsayResult({ result: { path: [{ subPath: [{ trafficType: 4, sectionTime: 60 }] }] } }).error.code, '-99');
});

test('지하철 노선 · 버스 색: 서울시 실시간 번호(subwayId) · 공식 노선 색 · 간선 파랑 / 지선 · 일반 초록 / 광역 빨강', () => {
  assert.deepEqual(['수도권 4호선', '수도권 우이신설경전철', '수도권 신분당선', '수도권 수인분당선', '수도권 공항철도', '수도권 경의중앙선'].map((name) => subwayLine({ name }).subwayId),
    ['1004', '1092', '1077', '1075', '1065', '1063']);
  assert.equal(subwayLine({ name: '인천 1호선', subwayCode: 21 }).subwayId, null, '인천 1호선은 서울시 실시간 대상 아님');
  assert.equal(subwayLine({ subwayCode: 3 }).short, '3호선');
  assert.equal(subwayLine({ name: '부산 1호선', subwayCode: 71, subwayCityCode: 7000 }).subwayId, null);
  assert.deepEqual(['간선', '지선', '일반', '마을', '광역', '순환', '직행좌석'].map(busColor),
    [MODE_COLOR.blue, MODE_COLOR.green, MODE_COLOR.green, MODE_COLOR.green, MODE_COLOR.red, MODE_COLOR.yellow, MODE_COLOR.red]);
  assert.deepEqual([inkOn('#B0CE18'), inkOn('#0052A4'), inkOn('#FABE00')], ['#1D2430', '#FFFFFF', '#1D2430'], '밝은 노선 색에는 진한 글자');
});

test('실시간이 없을 때 기다림: 배차간격 절반 + 1분(없으면 지하철 4 · 버스 6, 2~12분)', () => {
  assert.deepEqual([stdWait({ kind: 'subway', intervalMin: 5 }), stdWait({ kind: 'bus', intervalMin: 9 }), stdWait({ kind: 'subway' }), stdWait({ kind: 'bus' }), stdWait({ kind: 'bus', intervalMin: 40 }), stdWait({ kind: 'subway', intervalMin: 1 })],
    [4, 6, 4, 6, 12, 2]);
});

test('표준 계산: 도보 → (기다림 + 이동) → 환승 도보 + 3분 → … → 정문 → 강의실, 수업 5분 전까지 닿는 가장 늦은 출발', () => {
  // 4 + (4+18) + (3+3) + (4+10) + (2+3) + (6+12) + 3 = 72분 + 정문→미래관
  const p = planTransit({ route: A, cls, nowMin: toMin('07:00'), walkTable: WALK_TABLE });
  const D = toMin('08:55') - 72 - W;
  assert.deepEqual([p.state, p.mode, p.status, p.pick.departMin, p.pick.classArriveMin, p.departNow], ['ok', 'transit', 'relaxed', D, toMin('08:55'), false]);
  assert.deepEqual(p.pick.legs.filter((l) => l.kind === 'walk' && l.transfer).map((l) => l.safety), [3, 3], '환승 2번 × 3분');
  assert.deepEqual(p.pick.legs.filter((l) => l.kind !== 'walk').map((l) => [l.src, l.wait]), [['std', 4], ['std', 4], ['std', 6]]);
  assert.deepEqual([p.pick.trip.label, p.pick.trip.kind, p.pick.trip.stop, p.pick.boardMin], ['2호선', 'subway', '홍대입구', D + 4 + 4]);
  assert.equal(routeSummary(A).totalMin, 72);
  assert.equal(routeSummary(A, p).totalMin, 72 + W);
  // 내 걸음 반영 +3분 → 3분 일찍 출발
  const q = planTransit({ route: A, cls, nowMin: toMin('07:00'), walkTable: WALK_TABLE, personalOffsetMin: 3 });
  assert.deepEqual([q.pick.departMin, q.personalMin, q.pick.classArriveMin], [D - 3, 3, toMin('08:55')]);
});

test('첫 지하철 실시간: 역 입구 + 승강장 2분 뒤에 오는 열차부터 · 그 열차에 맞춰 출발 · 받은 열차 뒤로는 배차간격', () => {
  // 실시간 열차 N+5분 · N+12분. 열차 시각 T면 강의실 도착 = T + 64 + W → 08:55까지 되는 가장 늦은 열차는 N+12
  const N = toMin('08:55') - 76 - W - 1; // N + 12 + 64 + W = 08:54
  const rt = { first: { i: 1, kind: 'subway', trains: [{ etaSec: 300 }, { etaSec: 720 }] } };
  const p = planTransit({ route: A, cls, nowMin: N, rt, walkTable: WALK_TABLE });
  const sub = p.pick.legs.find((l) => l.kind === 'subway');
  assert.deepEqual([p.pick.departMin, sub.board, sub.src, p.liveFirst, p.pick.live], [N + 6, N + 12, 'live', true, true]);
  assert.equal(p.pick.classArriveMin, N + 12 + 64 + W);
  // 승강장 2분 여유: N+5 열차는 N-1에 나가야 해서 못 탐 → 지금 나가면 N+12 열차
  const late = planTransit({ route: A, cls: { ...cls, start: toHHMM(N + 12 + 64 + W + 3) }, nowMin: N, rt, walkTable: WALK_TABLE });
  assert.deepEqual([late.departNow, late.status, late.pick.legs.find((l) => l.kind === 'subway').board], [true, 'tight', N + 12]);
});

test('마지막 버스 실시간(국민대행): 서울시 도착 예정 · 실시간 차내 시간 · 하차 문 → 강의실(ODsay 마지막 도보 대신)', () => {
  const nowMin = toMin('08:00');
  const trip = { no: '1213', type: '지선', etasSec: [20 * 60, 29 * 60], termMin: 9, inVehicleMin: 10.5, gate: '후문', msgs: [] };
  const rt = { final: { i: 5, trips: [trip] } };
  const sim = simulate(A, nowMin, { cls, nowMin, rt, walkTable: WALK_TABLE });
  const bus = sim.legs.find((l) => l.kind === 'bus');
  // 도착(정류장) = 08:00 + 4+4+18+6+4+10+5 = 08:51 → 08:20 차는 놓치고 08:29 → … 08:56 차(배차 9분)
  assert.deepEqual([bus.arrive, bus.src, bus.ride, sim.gate], [nowMin + 51, 'term', 10.5, '후문']);
  assert.equal(bus.board, nowMin + 56);
  assert.equal(sim.classArriveMin, nowMin + 56 + 10.5 + WALK_TABLE['미래관']['후문']);
  assert.ok(!sim.legs.some((l) => l.kind === 'walk' && l.i === 6), 'ODsay 마지막 도보는 빼고 하차 문 → 강의실');
});

test('늦음 · 수업 시작 · 수업 없음 · 알림 문장(첫 탑승 이름)', () => {
  const p = planTransit({ route: A, cls, nowMin: toMin('08:00'), walkTable: WALK_TABLE });
  assert.deepEqual([p.departNow, p.status, p.pick.departMin], [true, 'late', toMin('08:00')]);
  assert.equal(planTransit({ route: A, cls, nowMin: toMin('09:01'), walkTable: WALK_TABLE }).state, 'started');
  assert.equal(planTransit({ route: A, cls: null, nowMin: 0, walkTable: WALK_TABLE }).state, 'no-class');
  const ok = planTransit({ route: A, cls, nowMin: toMin('07:00'), walkTable: WALK_TABLE });
  const [a] = decideAlarms({ rec: ok, nowMin: ok.pick.departMin - 10 });
  assert.equal(a.type, 'depart');
  assert.match(a.body, /^2호선 \d{2}:\d{2} 탑승 · 강의실 08:55 도착 예정\(여유\)$/);
  const busFirst = planTransit({ route: paths[1], cls, nowMin: toMin('07:00'), walkTable: WALK_TABLE });
  assert.equal(firstBoard(paths[1], simulate(paths[1], busFirst.pick.departMin, { cls, nowMin: 420, walkTable: WALK_TABLE })).label, '272번');
  assert.match(decideAlarms({ rec: busFirst, nowMin: busFirst.pick.departMin })[0].body, /^272번 /);
  // 출발이 앞당겨지면: 직행은 '도로 정체', 환승은 '실시간 도착 정보'로 이유를 밝힘
  const [e] = decideAlarms({ rec: ok, nowMin: ok.pick.departMin - 5, fired: { depart: { departMin: ok.pick.departMin + 10 } } });
  assert.equal(e.type, 'earlier');
  assert.match(e.body, /^실시간 도착 정보가 바뀌었어요\. 2호선 /);
});

test('요약 막대: 도보 회색 · 지하철 하늘색 · 지선 초록 · 간선 파랑, 기다림 · 여유 포함 총 소요 · 실시간 쓸 때', () => {
  const s = routeSummary(A);
  assert.deepEqual(s.segments.map((x) => [x.kind, x.min, x.color]), [['walk', 4, MODE_COLOR.walk], ['subway', 18, MODE_COLOR.subway], ['walk', 3, MODE_COLOR.walk], ['subway', 10, MODE_COLOR.subway], ['walk', 2, MODE_COLOR.walk], ['bus', 12, MODE_COLOR.green], ['walk', 3, MODE_COLOR.walk]]);
  assert.equal(routeSummary(paths[1]).segments[1].color, MODE_COLOR.blue);
  assert.deepEqual([durationText(72), durationText(115), durationText(120), durationText(9)], ['1시간 12분', '1시간 55분', '2시간', '9분']);
  const std = planTransit({ route: A, cls, nowMin: toMin('07:00'), walkTable: WALK_TABLE });
  const d = std.pick.departMin;
  assert.deepEqual([wantsLive(std, d - 31), wantsLive(std, d - 30), wantsLive(std, d + 20), wantsLive(std, d + 21)], [false, true, true, false]);
  assert.ok(Math.abs(distanceM({ x: SAMPLE_ODSAY_ORIGIN.lon, y: SAMPLE_ODSAY_ORIGIN.lat }, KOOKMIN_GATE) - 8780) < 50, '홍대입구 → 국민대 정문 약 8.8km');
  assert.equal(TRANSIT.transferSafetyMin, 3);
});

test('실시간 지하철 해석: barvlDt − 받은 뒤 흐른 초 · 0이면 문구로 보수적 추정 · 떠난 열차 · 5분 넘은 기록은 뺌', () => {
  const at = Date.parse('2026-11-16T08:00:30+09:00');
  const row = (o) => ({ subwayId: '1004', updnLine: '상행', trainLineNm: '진접행 - 동대문방면', bstatnNm: '진접', recptnDt: '2026-11-16 08:00:00', barvlDt: '0', arvlCd: '99', arvlMsg2: '', btrainSttus: '일반', lstcarAt: '0', ...o });
  assert.deepEqual([parseSubwayRow(row({ barvlDt: '240' }), at).etaSec, parseSubwayRow(row({ barvlDt: '240' }), at).next], [210, '동대문']);
  assert.equal(parseSubwayRow(row({ arvlMsg2: '3분 20초 후 (혜화)' }), at).etaSec, 170);
  assert.deepEqual([parseSubwayRow(row({ arvlMsg2: '[4]번째 전역 (한성대입구)' }), at).etaSec, parseSubwayRow(row({ arvlMsg2: '[4]번째 전역' }), at).approx], [330, true]);
  assert.deepEqual([parseSubwayRow(row({ arvlCd: '5', arvlMsg2: '전역 도착' }), at).etaSec, parseSubwayRow(row({ arvlCd: '1', arvlMsg2: '동대문역사문화공원 도착' }), at).etaSec], [30, 0]);
  assert.equal(parseSubwayRow(row({ arvlCd: '2' }), at), null, '떠난 열차');
  assert.equal(parseSubwayRow(row({ barvlDt: '240', recptnDt: '2026-11-16 07:54:00' }), at), null, '6분 넘게 지난 기록');
  assert.equal(parseSubwayRow(row({ arvlMsg2: '운행 중' }), at), null, '시간을 알 수 없음');
  assert.equal(parseSubwayRow(row({ barvlDt: '90', btrainSttus: '급행' }), at).express, true);
});

test('응답 상태 · 이 구간에 탈 열차만(같은 노선 · 같은 방향 · 하차역 전에 끝나는 열차 · 급행 제외), 방향을 모르면 안 씀', () => {
  assert.deepEqual([subwayStatus({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [] }).status, subwayStatus({ status: 500, code: 'INFO-200', message: '해당하는 데이터가 없습니다.' }).status,
    subwayStatus({ code: 'INFO-100' }).status, subwayStatus({ code: 'ERROR-337' }).status, subwayStatus({}).status], ['ok', 'nodata', 'auth', 'quota', 'api']);
  const leg = A.legs[3]; // 4호선 동대문역사문화공원 → 길음, 다음 역 동대문
  const at = Date.parse('2026-11-16T08:00:00+09:00');
  const json = exampleSubwayJson({ subwayId: '1004', station: '동대문역사문화공원', next: '동대문', dest: '진접', etasSec: [400, 100], recptnMs: at });
  json.realtimeArrivalList.push(
    { ...json.realtimeArrivalList[0], updnLine: '하행', trainLineNm: '오이도행 - 충무로방면', bstatnNm: '오이도', barvlDt: '30' }, // 반대 방향
    { ...json.realtimeArrivalList[0], subwayId: '1002', trainLineNm: '성수행 - 신당방면', bstatnNm: '성수', barvlDt: '50' }, // 다른 노선
    { ...json.realtimeArrivalList[0], trainLineNm: '한성대입구행 - 동대문방면', bstatnNm: '한성대입구', barvlDt: '60' },     // 하차역(길음) 전에 끝남
    { ...json.realtimeArrivalList[0], btrainSttus: '급행', barvlDt: '70' },
  );
  const parsed = parseSubwayArrivals(json, at);
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(trainsForLeg(parsed.rows, leg).map((t) => t.etaSec), [100, 400]);
  assert.deepEqual(trainsForLeg(parsed.rows, { ...leg, next: '', stations: [] }).map((t) => t.etaSec), [60, 100, 400], '다음 역을 모르면 상행/하행으로(2호선 제외)');
  assert.deepEqual(trainsForLeg(parsed.rows, { ...A.legs[1], next: '' }), [], '2호선은 방향(다음 역)을 모르면 안 씀');
  assert.equal(stationKey('총신대입구(이수)역'), '총신대입구');
});
