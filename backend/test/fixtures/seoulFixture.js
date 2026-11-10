// 테스트용 서울시 API 응답 생성기 — 형식(XML 요소 이름·값이 모두 문자열)은 공식 활용가이드 예제와 같고, 값은 가상입니다.
// 정류장 이름은 국민대 주변 OSM 정류장 이름을 빌렸을 뿐, 실제 노선이 이 순서로 지나는지와는 관계없습니다.

/** 노선 3개가 같은 승차 정류장(08901 정릉시장)에서 출발하는 가상 노선 */
export const ROUTES = {
  171: { busRouteId: '900000171', routeType: '3' },
  1711: { busRouteId: '900001711', routeType: '4' },
  1112: { busRouteId: '900001112', routeType: '4' },
};

// [seq, 이름, arsId, fullSectDist(m), sectSpd(km/h), 회차]
export const STATIONS = {
  900000171: [
    [1, '테스트기점', '08900', 0, 0], [2, '정릉시장', '08901', 620, 24], [3, '정릉3동주민센터앞', '08902', 480, 18],
    [4, '고려대사범대학부속고등학교', '08903', 530, 5], [5, '청덕초등학교입구', '08904', 410, 4], [6, '국민대학교앞', '08905', 360, 8],
    [7, '국민대앞', '08906', 120, 18], [8, '테스트회차지', '08907', 900, 30, 'Y'], [9, '국민대학교앞', '08909', 900, 30],
    [10, '청덕초등학교입구', '08910', 380, 20], [11, '정릉시장', '08911', 1500, 25],
  ],
  900001711: [
    [1, '테스트기점', '08900', 0, 0], [2, '정릉시장', '08901', 600, 20], [3, '정릉3동주민센터앞', '08902', 480, 20],
    [4, '청덕초등학교입구', '08904', 700, 6], [5, '국민대앞', '08906', 500, 10], [6, '테스트회차지', '08907', 800, 30, 'Y'],
  ],
  900001112: [
    [1, '테스트기점', '08900', 0, 0], [2, '정릉시장', '08901', 600, 20], [3, '정릉3동주민센터앞', '08902', 480, 22],
    [4, '청덕초등학교입구', '08904', 650, 15], [5, '국민대후문', '08912', 600, 18], [6, '테스트회차지', '08907', 800, 30, 'Y'],
  ],
};

/** 정류장 08901(정릉시장) 도착 예정 */
export const ARRIVALS = {
  '08901': [
    { busRouteId: '900000171', rtNm: '171', busRouteAbrv: '171', staOrd: '2', arrmsg1: '3분후[1번째 전]', traTime1: '180', arrmsg2: '12분후[5번째 전]', traTime2: '720', vehId1: '111000001', vehId2: '111000002', congestion1: '4', congestion2: '3', term: '8' },
    { busRouteId: '900001711', rtNm: '1711', busRouteAbrv: '1711', staOrd: '2', arrmsg1: '곧 도착', traTime1: '0', arrmsg2: '9분후[4번째 전]', traTime2: '540', term: '10' },
    { busRouteId: '900001112', rtNm: '1112', busRouteAbrv: '1112', staOrd: '2', arrmsg1: '6분10초후[3번째 전]', traTime1: '370', arrmsg2: '운행종료', traTime2: '0', term: '12' },
    { busRouteId: '900007211', rtNm: '7211', busRouteAbrv: '7211', staOrd: '14', arrmsg1: '1분후[1번째 전]', traTime1: '60', term: '9' },
  ],
};

/** 정류장 검색(getStationByName: stId·stNm·tmX·tmY·arsId / getStationByPos: stationId·stationNm·gpsX·gpsY·arsId·dist) */
export const STOPS = [
  { stId: '108000001', stNm: '정릉시장', arsId: '08901', tmX: '127.0101', tmY: '37.6060' },
  { stId: '108000011', stNm: '정릉시장', arsId: '08911', tmX: '127.0104', tmY: '37.6062' },
  { stId: '108000002', stNm: '정릉3동주민센터앞', arsId: '08902', tmX: '127.0046', tmY: '37.6086' },
  { stId: '108000005', stNm: '국민대학교앞', arsId: '08905', tmX: '126.9970', tmY: '37.6106' },
];

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function xml(items, { code = '0', msg = '정상적으로 처리되었습니다.' } = {}) {
  const body = items.map((o) => `<itemList>${Object.entries(o).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</itemList>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ServiceResult><comMsgHeader/><msgHeader><headerCd>${code}</headerCd><headerMsg>${msg}</headerMsg><itemCount>0</itemCount></msgHeader><msgBody>${body}</msgBody></ServiceResult>`;
}
export function json(items, { code = '0', msg = '정상적으로 처리되었습니다.' } = {}) {
  return JSON.stringify({ comMsgHeader: {}, msgHeader: { headerCd: code, headerMsg: msg, itemCount: 0 }, msgBody: { itemList: items.length === 1 ? items[0] : items } });
}

export const stationItems = (id, speeds = {}) => (STATIONS[id] || []).map(([seq, name, arsId, dist, spd, turn]) => ({
  busRouteId: id, busRouteNm: Object.keys(ROUTES).find((k) => ROUTES[k].busRouteId === String(id)) || '', seq: String(seq), section: seq === 1 ? '0' : `${id}${seq}`,
  station: `1${arsId}0000`.slice(0, 9), stationNm: name, arsId, stationNo: arsId, fullSectDist: String(dist), sectSpd: String(speeds[seq] ?? spd),
  direction: '테스트', transYn: turn === 'Y' ? 'Y' : 'N', gpsX: '127.0', gpsY: '37.6', routeType: '3',
}));

/**
 * fetch 대신 쓰는 가짜 서울시 서버. calls에 요청 URL을 남깁니다.
 * @param {{ format?:'xml'|'json', speeds?:Record<string,Record<number,number>>, fail?:(url:URL)=>any }} o
 */
export function fakeSeoulFetch({ format = 'xml', speeds = {}, fail } = {}) {
  const calls = [];
  const out = format === 'json' ? json : xml;
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const custom = fail && (await fail(u));
    if (custom) return custom;
    const ok = (body) => ({ ok: true, status: 200, text: async () => body });
    if (u.pathname.endsWith('/busRouteInfo/getBusRouteList')) {
      const q = u.searchParams.get('strSrch');
      const items = Object.entries(ROUTES).filter(([no]) => no.includes(q)).map(([no, r]) => ({ busRouteId: r.busRouteId, busRouteNm: no, busRouteAbrv: no, routeType: r.routeType, term: '8' }));
      return ok(items.length ? out(items) : out([], { code: '4', msg: '노선을 찾을 수 없습니다.' }));
    }
    if (u.pathname.endsWith('/busRouteInfo/getStaionByRoute')) {
      const id = u.searchParams.get('busRouteId');
      return ok(out(stationItems(id, speeds[id] || {})));
    }
    if (u.pathname.endsWith('/stationinfo/getStationByName')) {
      const q = u.searchParams.get('stSrch');
      const items = STOPS.filter((x) => x.stNm.includes(q));
      return ok(items.length ? out(items) : out([], { code: '3', msg: '정류소를 찾을 수 없습니다' }));
    }
    if (u.pathname.endsWith('/stationinfo/getStationByPos')) {
      const items = STOPS.slice(0, 3).map((x, i) => ({ stationId: x.stId, stationNm: x.stNm, gpsX: x.tmX, gpsY: x.tmY, arsId: x.arsId, dist: String([120, 35, 260][i]), stationTp: '0' }));
      return ok(out(items));
    }
    if (u.pathname.endsWith('/stationinfo/getStationByUid')) {
      const items = ARRIVALS[u.searchParams.get('arsId')];
      return ok(items ? out(items) : out([], { code: '3', msg: '정류소를 찾을 수 없습니다' }));
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  fn.calls = calls;
  return fn;
}

/** 테스트에서 쓰는 사용자 노선(승차 08901 정릉시장) */
export const USER_ROUTES = [
  { id: '171', no: '171', type: '간선', gate: '정문', stop: '국민대학교앞', alightName: '국민대학교앞', boardArsId: '08901', usualMin: 12, corridor: '정릉로', enabled: true },
  { id: '1711', no: '1711', type: '지선', gate: '정문', stop: '국민대앞', alightName: '국민대앞', boardArsId: '08901', usualMin: 14, corridor: '정릉로', enabled: true },
  { id: '1112', no: '1112', type: '지선', gate: '후문', stop: '국민대후문', alightName: '국민대후문', boardArsId: '08901', usualMin: 13, corridor: '정릉로9길', enabled: true },
];

/** 공식 계산식으로 기대값: Σ(거리/속도) + 중간 정류장×20초 */
export function expectedMinutes(id, boardSeq, alightSeq, speeds = {}) {
  const rows = STATIONS[id].filter(([seq]) => seq > boardSeq && seq <= alightSeq);
  const moving = rows.reduce((a, [seq, , , dist, spd]) => { const v = speeds[seq] ?? spd; const kmh = v > 2 && v < 90 ? v : 15; return a + dist / ((kmh * 1000) / 60); }, 0);
  return moving + ((rows.length - 1) * 20) / 60;
}
