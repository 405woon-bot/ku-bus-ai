// 테스트용 가짜 경기도 버스 API(공공데이터포털 GBIS v2). 응답 모양은 안내(공공데이터포털 출력결과 · GBIS 매뉴얼) 기준의 예시이고,
// 정류장 · 노선 · 도착 값은 모두 예시입니다(실제 운행 정보 아님). 실제 응답 형식은 배포 뒤 /api/gyeonggi/test로 확인합니다.
export const GG_TEST_KEY = 'GG+TEST/KEY=='; // Decoding 키처럼 + / = 가 들어 있음(한 번만 인코딩해야 통함)

const STATIONS = [
  { stationId: 202000005, stationName: '수원역', mobileNo: '03128', regionName: '수원', x: 127.0003, y: 37.2659, centerYn: 'N', districtCd: 2 },
  { stationId: 202000061, stationName: '수원역.AK플라자', mobileNo: '03131', regionName: '수원', x: 127.0011, y: 37.2664, centerYn: 'N', districtCd: 2 },
];
const ARRIVALS = [
  { routeId: 200000085, routeName: '7770', routeTypeCd: 14, staOrder: 18, routeDestName: '사당역', flag: 'PASS', predictTime1: 5, predictTimeSec1: 290, locationNo1: 3,
    stationNm1: '수원역.AK플라자', remainSeatCnt1: 12, crowded1: 1, stateCd1: 2, lowPlate1: 0, plateNo1: '경기70아1234', vehId1: 223300001, predictTime2: 18, predictTimeSec2: 1080, locationNo2: 9 },
  { routeId: 200000112, routeName: '1007', routeTypeCd: 11, staOrder: 7, routeDestName: '강남역', flag: 'PASS', predictTime1: 11, predictTimeSec1: 640, locationNo1: 6,
    stationNm1: '세류역', remainSeatCnt1: -1, crowded1: 2, stateCd1: 1, lowPlate1: 1, plateNo1: '경기70아5678', vehId1: 223300002 },
];
const VIA = [
  { routeId: 200000085, routeName: '7770', routeTypeCd: 14, routeTypeName: '직행좌석형시내버스', staOrder: 18, routeDestId: 100000001, routeDestName: '사당역', regionName: '수원' },
  { routeId: 200000112, routeName: '1007', routeTypeCd: 11, routeTypeName: '직행좌석형시내버스', staOrder: 7, routeDestId: 100000002, routeDestName: '강남역', regionName: '수원' },
];
const ROUTE_STATIONS = Array.from({ length: 25 }, (_, i) => ({
  stationSeq: i + 1, stationId: i === 17 ? 202000005 : 202100000 + i, stationName: i === 17 ? '수원역' : `예시정류장${i + 1}`, mobileNo: String(3000 + i).padStart(5, '0'),
  turnYn: i === 24 ? 'Y' : 'N', turnSeq: 25, districtCd: i >= 22 ? 1 : 2, adminName: i >= 22 ? '서울특별시' : '수원시', regionName: i >= 22 ? '서울' : '수원', x: 127 + i * 0.001, y: 37.26 + i * 0.01, centerYn: 'N',
}));
const AROUND = [
  { stationId: 202000005, stationName: '수원역', mobileNo: '03128', regionName: '수원', x: 127.0003, y: 37.2659, distance: 0 },
  { stationId: 202000061, stationName: '수원역.AK플라자', mobileNo: '03131', regionName: '수원', x: 127.0011, y: 37.2664, distance: 92 },
  { stationId: 202000077, stationName: '매산로입구', mobileNo: '03140', regionName: '수원', x: 127.004, y: 37.268, distance: 187 },
];
const DATA = {
  getBusStationListv2: ['busStationList', STATIONS], getBusArrivalListv2: ['busArrivalList', ARRIVALS], getBusStationViaRouteListv2: ['busRouteList', VIA],
  getBusRouteStationListv2: ['busRouteStationList', ROUTE_STATIONS], getBusStationAroundListv2: ['busStationAroundList', AROUND],
};

const resp = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
/** 공공데이터포털 게이트웨이 오류(XML) */
export const gatewayXml = (name, code) => `<OpenAPI_ServiceResponse>\n  <cmmMsgHeader>\n    <errMsg>SERVICE ERROR</errMsg>\n    <returnAuthMsg>${name}</returnAuthMsg>\n    <returnReasonCode>${code}</returnReasonCode>\n  </cmmMsgHeader>\n</OpenAPI_ServiceResponse>`;
/** GBIS 응답 — wrapped: response · comMsgHeader · msgHeader · msgBody(공공데이터포털 표) / flat: 머리말 필드와 목록이 바로(GBIS 매뉴얼 표) */
export function gbisJson(listKey, items, { envelope = 'wrapped', resultCode = 0, single = false } = {}) {
  const msg = { 0: '정상적으로 처리되었습니다.', 4: '결과가 존재하지 않습니다.', 1: '시스템 에러가 발생하였습니다.', 2: '필수 요청 Parameter가 존재하지 않습니다.' }[resultCode] || '알 수 없음';
  const head = { queryTime: '2026-11-24 13:00:00.000', resultCode, resultMessage: msg };
  const list = resultCode === 0 ? { [listKey]: single && items.length === 1 ? items[0] : items } : null;
  if (envelope === 'flat') return { ...head, ...(list || {}) };
  return { response: { comMsgHeader: { errMsg: null, returnCode: null, requestMsgID: null, responseMsgID: null, responseTime: null, successYN: null }, msgHeader: head, ...(list ? { msgBody: list } : {}) } };
}

/**
 * @param {{ key?, envelope?, deny?: string[], nodata?: string[], single?: boolean, respond?: (u: URL, raw: string) => any }} o
 *   deny: 이 서비스 경로('busarrivalservice' 등)는 SERVICE_ACCESS_DENIED_ERROR / nodata: 이 기능은 결과 없음(4)
 */
export function fakeGyeonggiFetch({ key = GG_TEST_KEY, envelope = 'wrapped', deny = [], nodata = [], single = false, respond } = {}) {
  const calls = [];
  const fn = async (url) => {
    const raw = String(url), u = new URL(raw);
    const parts = u.pathname.split('/'); // ['', '6410000', 'busstationservice', 'v2', 'getBusStationListv2']
    calls.push({ url: u, raw, service: parts[2], op: parts[4] });
    const custom = respond && respond(u, raw);
    if (custom) return custom.text ? custom : resp(200, typeof custom === 'string' ? custom : JSON.stringify(custom));
    if (u.protocol !== 'https:' || u.hostname !== 'apis.data.go.kr' || parts[1] !== '6410000' || parts[3] !== 'v2') return resp(404, 'API not found');
    const m = /[?&]serviceKey=([^&]*)/.exec(raw);
    if (!m || decodeURIComponent(m[1]) !== key) return resp(200, gatewayXml('SERVICE_KEY_IS_NOT_REGISTERED_ERROR', 30));
    if (deny.includes(parts[2])) return resp(200, gatewayXml('SERVICE_ACCESS_DENIED_ERROR', 20));
    const d = DATA[parts[4]];
    if (!d) return resp(200, gatewayXml('NO_OPENAPI_SERVICE_ERROR', 12));
    if (u.searchParams.get('format') !== 'json') return resp(200, '<response><msgHeader><resultCode>0</resultCode></msgHeader></response>');
    const need = { getBusStationListv2: 'keyword', getBusArrivalListv2: 'stationId', getBusStationViaRouteListv2: 'stationId', getBusRouteStationListv2: 'routeId', getBusStationAroundListv2: 'x' }[parts[4]];
    if (!u.searchParams.get(need)) return resp(200, JSON.stringify(gbisJson(d[0], [], { envelope, resultCode: 2 })));
    if (nodata.includes(parts[4])) return resp(200, JSON.stringify(gbisJson(d[0], [], { envelope, resultCode: 4 })));
    return resp(200, JSON.stringify(gbisJson(d[0], d[1], { envelope, single })));
  };
  fn.calls = calls;
  return fn;
}
