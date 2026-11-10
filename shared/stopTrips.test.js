import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemsOf, parseArrmsg, parseArrivals, parseStations, parseStopSearch, computeTrips, tripFromStations, congestionLevel, gateOf, mockTrips, sectionConvention,
} from './stopTrips.js';
import { busTimes, recommend } from './recommend.js';
import { SAMPLE_ARRIVALS, SAMPLE_ROUTE_STATIONS, SAMPLE_STOP_SEARCH } from './samples/seoulSample.js';

const stationsByRoute = Object.fromEntries(Object.entries(SAMPLE_ROUTE_STATIONS).map(([k, v]) => [k, parseStations(itemsOf(v))]));

test('도착 안내 문구 해석', () => {
  assert.equal(parseArrmsg('4분12초후[2번째 전]'), 252);
  assert.equal(parseArrmsg('3분후[1번째 전]'), 180);
  assert.equal(parseArrmsg('곧 도착'), 30);
  assert.equal(parseArrmsg('출발대기'), null);
  assert.equal(parseArrmsg('운행종료'), null);
});

test('응답 코드: 0 정상, 3·4·7·8은 결과 없음(빈 목록), 그 밖은 예외 · 항목 하나짜리 응답도 배열로', () => {
  assert.throws(() => itemsOf({ msgHeader: { headerCd: '1', headerMsg: '시스템 오류' } }), /시스템 오류/);
  assert.deepEqual(itemsOf({ msgHeader: { headerCd: '4' }, msgBody: { itemList: null } }), []);
  assert.deepEqual(itemsOf({ msgHeader: { headerCd: '7' } }), []);
  assert.equal(itemsOf({ msgHeader: { headerCd: '0' }, msgBody: { itemList: { arsId: '1' } } }).length, 1);
});

test('정류장 검색: 이름 검색(stNm·tmX·tmY)과 주변 검색(stationNm·gpsX·gpsY·dist), 같은 번호는 한 번만', () => {
  const s = parseStopSearch(itemsOf(SAMPLE_STOP_SEARCH));
  assert.equal(s.length, 3); assert.equal(s[0].name, '고려대사범대학부속고등학교'); assert.ok(Math.abs(s[0].lat - 37.60785) < 1e-6);
  const near = parseStopSearch([
    { stationId: '108000001', stationNm: '정릉시장', gpsX: '127.01', gpsY: '37.606', arsId: '08901', dist: '42' },
    { stationId: '108000001', stationNm: '정릉시장', gpsX: '127.01', gpsY: '37.606', arsId: '08901', dist: '42' },
    { stationId: '1', stationNm: '가상정류장', arsId: '0' },
  ]);
  assert.deepEqual(near.map((x) => [x.arsId, x.name, x.distM]), [['08901', '정릉시장', 42]]);
});

test('도착 정보: 공식 필드 traTime(초) 우선, 없으면 arrmsg 해석 · term/Term · 운행종료', () => {
  const [a, b, c] = parseArrivals([
    { busRouteId: '1', rtNm: '171', routeType: '3', staOrd: '20', traTime1: '151', arrmsg1: '2분후[2번째 전]', traTime2: '0', arrmsg2: '9분후[5번째 전]', term: '9', congestion1: '5' },
    { busRouteId: '2', rtNm: '1112', routeType: '4', staOrd: '8', arrmsg1: '곧 도착', arrmsg2: '운행종료', Term: '14' },
    { busRouteId: '3', rtNm: '1213', routeType: '4', arrmsg1: '운행종료', arrmsg2: '운행종료' },
  ]);
  assert.deepEqual([a.no, a.type, a.staOrd, a.etasSec, a.termMin, a.crowd], ['171', '간선', 20, [151, 540], 9, '혼잡']);
  assert.deepEqual([b.etasSec, b.termMin, b.ended], [[30], 14, false]);
  assert.equal(c.ended, true);
  // 막차(둘째 차 운행종료)는 배차간격으로 잇지 않고, 운행이 끝난 노선은 후보 없음
  assert.equal(busTimes(b, 480, 600).length, 1);
  assert.deepEqual(busTimes(c, 480, 600), []);
});

test('국민대로 가는 노선만 자동으로 고르고 차내 시간·정체·원인을 계산', () => {
  const trips = computeTrips({ arrivals: parseArrivals(itemsOf(SAMPLE_ARRIVALS['S-01'])), stationsByRoute, boardArsId: 'S-01' });
  assert.deepEqual(trips.map((t) => [t.no, t.alightName, t.gate]), [['171', '국민대학교앞', '정문'], ['1112', '국민대후문', '후문'], ['1213', '국민대학교앞', '정문']]);
  const t171 = trips[0];
  // 186 m @15 km/h + 556 m @9 km/h + 중간 정류장 1곳 20초 = 0.744 + 3.707 + 0.333
  assert.ok(Math.abs(t171.inVehicleMin - 4.784) < 0.01, String(t171.inVehicleMin));
  assert.equal(t171.congestion, 'heavy');
  assert.equal(trips[1].congestion, 'normal');
  assert.deepEqual(t171.etasSec, [240, 780]); assert.equal(t171.termMin, 9);
  // 가장 느린 구간(9 km/h) → 매핑표의 도로 이름 / 표에 없는 노선은 정류장 이름 / 15 km/h 이상이면 원인 없음
  assert.deepEqual(t171.slowest, { from: '청덕초등학교입구', to: '국민대학교앞', kmh: 9, seq: 22 });
  assert.equal(t171.cause, '정릉로');
  assert.equal(trips[2].cause, '청덕초등학교입구→국민대학교앞 구간');
  assert.equal(trips[1].cause, null);
});

test('승차 정류장 뒤에 국민대가 없으면 제외 · 하차 정류장 이름은 띄어쓰기 무시', () => {
  assert.equal(tripFromStations(stationsByRoute.R7211, { boardArsId: 'S-01', boardSeq: 12 }), null);
  assert.equal(gateOf('국민대 후문'), '후문');
  assert.equal(gateOf('국민대학교 앞'), '정문');
  assert.equal(gateOf('정릉시장'), null);
});

test('구간 값이 출발 정류장 행에 있는 응답(마지막 행이 0)도 같은 결과', () => {
  const arrival = stationsByRoute.R171;
  // 같은 구간 값을 한 칸 앞 행으로 옮긴 응답
  const departure = arrival.map((s, i) => ({ ...s, sectDistM: arrival[i + 1]?.sectDistM ?? 0, sectSpdKmh: arrival[i + 1]?.sectSpdKmh ?? 0 }));
  assert.equal(sectionConvention(departure), 'departure');
  const a = tripFromStations(arrival, { boardArsId: 'S-01' }), d = tripFromStations(departure, { boardArsId: 'S-01' });
  assert.ok(Math.abs(a.inVehicleMin - d.inVehicleMin) < 1e-9);
  assert.deepEqual(a.slowest, d.slowest);
});

test('정체 기준', () => {
  assert.equal(congestionLevel(25), 'smooth'); assert.equal(congestionLevel(15), 'normal'); assert.equal(congestionLevel(8), 'heavy'); assert.equal(congestionLevel(NaN), 'unknown');
});

test('예시 노선(실시간 실패 시): transitModel 정릉로 시나리오 · 예시 표시 · 추천 계산 가능', () => {
  const t = mockTrips(8 * 60 + 10);
  assert.deepEqual(t.map((x) => x.no).sort(), ['1112', '171', '1711']);
  assert.ok(t.every((x) => x.example === true && x.etasSec.length === 2 && x.etasSec[0] > 0));
  const t171 = t.find((x) => x.no === '171');
  assert.deepEqual([t171.gate, t171.inVehicleMin, t171.congestion, t171.cause], ['정문', 20, 'heavy', '정릉로']);
  const rec = recommend({ trips: t, cls: { id: 'c1', name: '자료구조', start: '09:00', building: '미래관' }, nowMin: 8 * 60 + 10, walkTable: {} });
  assert.equal(rec.state, 'ok');
});
