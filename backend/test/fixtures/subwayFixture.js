// 테스트용 가짜 서울시 실시간 지하철(realtimeStationArrival). 응답 형식은 서울시 응답 그대로, 열차는 예시입니다.
import { exampleSubwayJson } from '../../../shared/subwayArrivals.js';

export const SUBWAY_TEST_KEY = 'SUBWAY-TEST-KEY';
// 역 이름 → 예시 열차(받은 시각 기준 남은 초)
export const SUBWAY_STATIONS = {
  홍대입구: { subwayId: '1002', next: '신촌', dest: '성수', etasSec: [150, 420], updn: '내선' },
  '총신대입구(이수)': { subwayId: '1004', next: '사당', dest: '오이도', etasSec: [200], updn: '하행' },
  동대문역사문화공원: { subwayId: '1004', next: '동대문', dest: '불암산', etasSec: [180, 480], updn: '상행' }, // v2.6.0 환승 지하철(예시 경로의 4호선)
};
const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });

export function fakeSubwayFetch({ key = SUBWAY_TEST_KEY, clock = () => Date.now(), stations = SUBWAY_STATIONS, respond } = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    const parts = u.pathname.split('/').map((x) => decodeURIComponent(x)); // ['', 'api', 'subway', KEY, 'json', 'realtimeStationArrival', '0', '20', 역명]
    calls.push({ url: u, raw: String(url), station: parts[8] });
    const custom = respond && respond(parts, u);
    if (custom) return custom.status ? custom : ok(custom);
    if (u.hostname !== 'swopenapi.seoul.go.kr' || parts[5] !== 'realtimeStationArrival') return { ok: false, status: 404, text: async () => 'not found' };
    if (parts[3] !== key) return ok({ status: 500, code: 'INFO-100', message: '인증키가 유효하지 않습니다. 인증키가 없는 경우, 열린 데이터 광장 홈페이지에서 인증키를 신청하십시오.' });
    const st = stations[parts[8]];
    if (!st) return ok({ status: 500, code: 'INFO-200', message: '해당하는 데이터가 없습니다.', link: '', developerMessage: '', total: 0 });
    return ok(exampleSubwayJson({ ...st, station: parts[8], recptnMs: clock() }));
  };
  fn.calls = calls;
  return fn;
}
