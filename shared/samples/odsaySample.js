// 미리보기 · 테스트용 예시 응답(ODsay 대중교통 길찾기 searchPubTransPathT 형식). 실제 경로 검색 결과가 아닙니다.
//   출발: 홍대입구역(예시) → 도착: 국민대학교 정문. 버스 정류장 번호(99-…)는 일부러 실제와 겹치지 않게 지은 값
const ST = {
  홍대입구: [126.923778, 37.557527], 신촌: [126.936893, 37.555134], 이대: [126.946013, 37.556733], 아현: [126.956141, 37.557345],
  충정로: [126.963693, 37.559973], 시청: [126.977022, 37.564022], 을지로입구: [126.982923, 37.566014], 을지로3가: [126.991806, 37.566306],
  을지로4가: [126.997985, 37.566697], 동대문역사문화공원: [127.007821, 37.565138], 동대문: [127.009382, 37.571420], 혜화: [127.001826, 37.582290],
  한성대입구: [127.006317, 37.588458], 성신여대입구: [127.016589, 37.592624], 길음: [127.025053, 37.603059],
};
const station = (name, i, extra = {}) => ({ index: i, stationID: 1000 + i, stationName: name, x: String(ST[name]?.[0] ?? 127), y: String(ST[name]?.[1] ?? 37.6), ...extra });
const walk = (distance, sectionTime) => ({ trafficType: 3, distance, sectionTime });
const subway = (laneName, code, names, sectionTime, way, wayCode, intervalTime) => ({
  trafficType: 1, distance: names.length * 1100, sectionTime, stationCount: names.length - 1, intervalTime,
  lane: [{ name: laneName, subwayCode: code, subwayCityCode: 1000 }],
  startName: names[0], startX: ST[names[0]][0], startY: ST[names[0]][1], endName: names[names.length - 1], endX: ST[names[names.length - 1]][0], endY: ST[names[names.length - 1]][1],
  way, wayCode, door: 'null', startID: 1000, endID: 1000 + names.length - 1, startExitNo: '9',
  passStopList: { stations: names.map((n, i) => station(n, i)) },
});
const bus = (busNo, type, from, to, sectionTime, stationCount, intervalTime) => ({
  trafficType: 2, distance: stationCount * 420, sectionTime, stationCount, intervalTime,
  lane: [{ busNo, type, busID: 90000 + Number(String(busNo).replace(/\D/g, '') || 0), busCityCode: 1000, busProviderCode: 4 }],
  startName: from.name, startX: from.x, startY: from.y, startID: 2000, startArsID: from.ars, startLocalStationID: `1${from.ars.replace('-', '')}0`,
  endName: to.name, endX: to.x, endY: to.y, endID: 2001, endArsID: to.ars,
  passStopList: { stations: [{ index: 0, stationID: 2000, stationName: from.name, x: String(from.x), y: String(from.y), arsID: from.ars, isNonStop: 'N' },
    { index: 1, stationID: 2001, stationName: to.name, x: String(to.x), y: String(to.y), arsID: to.ars, isNonStop: 'N' }] },
});
const STOP = {
  길음역: { name: '길음역', x: 127.025608, y: 37.603521, ars: '99-101' },
  국민대학교앞: { name: '국민대학교앞', x: 126.997107, y: 37.610674, ars: '99-102' },
  홍대입구역: { name: '홍대입구역', x: 126.924422, y: 37.556911, ars: '99-201' },
  동대문역사문화공원: { name: '동대문역사문화공원', x: 127.007396, y: 37.565829, ars: '99-202' },
};
const LINE2 = ['홍대입구', '신촌', '이대', '아현', '충정로', '시청', '을지로입구', '을지로3가', '을지로4가', '동대문역사문화공원'];
// v2.7.0 체험판 '환승 버스 예시'(예시 · 실제 경로 아님): 2호선 홍대입구 → 시청 · 환승 버스 150(시청앞.덕수궁 → 길음역) · 1213 → 국민대학교앞
const LINE2_CITYHALL = ['홍대입구', '신촌', '이대', '아현', '충정로', '시청'];
const CITYHALL_STOP = { name: '시청앞.덕수궁', x: 126.976876, y: 37.565431, ars: '99-203' };
const LINE4 = ['동대문역사문화공원', '동대문', '혜화', '한성대입구', '성신여대입구', '길음'];

export const SAMPLE_ODSAY_ORIGIN = { name: '홍대입구역', lat: 37.557527, lon: 126.923778 };
export const SAMPLE_ODSAY_RESPONSE = {
  result: {
    searchType: 0, outTrafficCheck: 0, busCount: 1, subwayCount: 1, subwayBusCount: 1, pointDistance: 8780, startRadius: 700, endRadius: 700,
    path: [
      {
        pathType: 3,
        info: { trafficDistance: 9620, totalWalk: 560, totalTime: 52, payment: 1500, busTransitCount: 1, subwayTransitCount: 2, mapObj: 'example', firstStartStation: '홍대입구', lastEndStation: '국민대학교앞', totalStationCount: 22, busStationCount: 8, subwayStationCount: 14, totalDistance: 10180, totalWalkTime: -1, checkIntervalTime: 100, checkIntervalTimeOverYn: 'N', totalIntervalTime: 20 },
        subPath: [walk(280, 4), subway('수도권 2호선', 2, LINE2, 18, '시청', 2, 5), walk(150, 3), subway('수도권 4호선', 4, LINE4, 10, '진접', 1, 6), walk(100, 2),
          bus('1213', 12, STOP.길음역, STOP.국민대학교앞, 12, 8, 9), walk(180, 3)],
      },
      {
        pathType: 3,
        info: { trafficDistance: 10400, totalWalk: 610, totalTime: 60, payment: 1500, busTransitCount: 2, subwayTransitCount: 1, mapObj: 'example', firstStartStation: '홍대입구역', lastEndStation: '국민대학교앞', totalStationCount: 29, busStationCount: 24, subwayStationCount: 5, totalDistance: 11010, totalWalkTime: -1 },
        subPath: [walk(200, 3), bus('272', 11, STOP.홍대입구역, STOP.동대문역사문화공원, 27, 16, 7), walk(150, 3), subway('수도권 4호선', 4, LINE4, 10, '진접', 1, 6), walk(100, 2),
          bus('1213', 12, STOP.길음역, STOP.국민대학교앞, 12, 8, 9), walk(180, 3)],
      },
      {
        pathType: 1,
        info: { trafficDistance: 9200, totalWalk: 1880, totalTime: 56, payment: 1400, busTransitCount: 0, subwayTransitCount: 2, mapObj: 'example', firstStartStation: '홍대입구', lastEndStation: '길음', totalStationCount: 14, busStationCount: 0, subwayStationCount: 14, totalDistance: 11080, totalWalkTime: -1 },
        subPath: [walk(280, 4), subway('수도권 2호선', 2, LINE2, 18, '시청', 2, 5), walk(150, 3), subway('수도권 4호선', 4, LINE4, 10, '진접', 1, 6), walk(1450, 21)],
      },
    ],
  },
};
/** 미리보기 출발지 검색용 예시 장소(실제 검색 결과 아님) — 예시 경로는 이 출발지 하나뿐 */
export const SAMPLE_ORIGINS = [{ arsId: '99201', name: '홍대입구역', lat: 37.556911, lon: 126.924422 }];

/**
 * v2.7.0 체험판 '환승 버스 예시' 단추용 경로 하나(ODsay 응답 형식의 예시 — 실제 경로 아님).
 *   2호선 홍대입구 → 시청(15분) · 걸어서 4분 · 환승 버스 150(간선, 배차 6분) 시청앞.덕수궁 → 길음역(26분) · 걸어서 2분 · 1213 길음역 → 국민대학교앞
 */
export const SAMPLE_ODSAY_MIDBUS = {
  result: {
    searchType: 0, outTrafficCheck: 0, busCount: 0, subwayCount: 0, subwayBusCount: 1, pointDistance: 8780, startRadius: 700, endRadius: 700,
    path: [
      {
        pathType: 3,
        info: { trafficDistance: 12100, totalWalk: 580, totalTime: 66, payment: 1500, busTransitCount: 2, subwayTransitCount: 1, mapObj: 'example', firstStartStation: '홍대입구', lastEndStation: '국민대학교앞', totalStationCount: 27, busStationCount: 22, subwayStationCount: 5, totalDistance: 12680, totalWalkTime: -1 },
        subPath: [walk(280, 4), subway('수도권 2호선', 2, LINE2_CITYHALL, 15, '시청', 2, 5), walk(200, 4), bus('150', 11, CITYHALL_STOP, STOP.길음역, 26, 14, 6), walk(100, 2),
          bus('1213', 12, STOP.길음역, STOP.국민대학교앞, 12, 8, 9), walk(180, 3)],
      },
    ],
  },
};
