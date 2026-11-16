// 테스트용 서울시 실시간 돌발정보(AccInfo) 응답 — 형식은 실제 응답(XML, 값은 모두 문자열)과 같고, 값은 가상입니다.
// 기준 시각: 2026-11-09(월) 08:10 서울 (e2e 서버 시계와 같음)
import { latLonToTm } from '../../../shared/incidents.js';

const at = (lat, lon) => { const { x, y } = latLonToTm(lat, lon); return { grs80tm_x: x.toFixed(4), grs80tm_y: y.toFixed(4) }; };
const row = (o) => ({ acc_dtype: '', link_id: '1000000000', acc_road_code: '000', ...o });

/** 경로 위 공사(보여 줌) · 국민대 근처 행사 10~12시(보여 줌, 예정) · 차량고장(종류 제외) · 봉은교(멀어서 제외) · 어제 끝난 사고 · 11/20 행사(3시간 넘게 뒤) */
export const ACC_ROWS = [
  row({ acc_id: 'T-WORK', occr_date: '20261101', occr_time: '0900', exp_clr_date: '20270228', exp_clr_time: '235900', acc_type: 'A04', acc_dtype: '04B01', ...at(37.6082, 127.0012),
    acc_info: '정릉로 하수관 정비공사(테스트)-일시 : 26.11.1(일)09:00~27.2.28(일) 23:59-장소 : 정릉로 청덕초등학교입구 앞-통제 : 국민대 방향 1개 차로 통제' }),
  row({ acc_id: 'T-EVENT', occr_date: '20261109', occr_time: '1000', exp_clr_date: '20261109', exp_clr_time: '120000', acc_type: 'A10', ...at(37.6140, 126.9925),
    acc_info: '거리 행사(테스트)-장소 : 국민대 근처-통제 : 일부 차로 통제' }),
  row({ acc_id: 'T-CAR', occr_date: '20261109', occr_time: '0750', exp_clr_date: '20261109', exp_clr_time: '090000', acc_type: 'A02', ...at(37.6083, 127.0030), acc_info: '차량 고장(테스트)' }),
  row({ acc_id: '1071788', occr_date: '20260407', occr_time: '1000', exp_clr_date: '20270301', exp_clr_time: '000000', acc_type: 'A04', acc_dtype: '04B01', link_id: '1220031600',
    grs80tm_x: '206076.7132692197', grs80tm_y: '446245.6950463236', acc_info: '탄천나들목 및 봉은교 구조개선공사-일시 : 26.4.7(화)10:00~27.2.28(일) 23:59-장소 : 봉은교-통제 : 양방향 전면통제', acc_road_code: '009' }),
  row({ acc_id: 'T-OLD', occr_date: '20261108', occr_time: '0700', exp_clr_date: '20261108', exp_clr_time: '090000', acc_type: 'A01', ...at(37.6084, 127.0008), acc_info: '추돌 사고(테스트, 어제 끝남)' }),
  row({ acc_id: 'T-LATER', occr_date: '20261120', occr_time: '1400', exp_clr_date: '20261120', exp_clr_time: '170000', acc_type: 'A10', ...at(37.6100, 126.9975), acc_info: '집회(테스트, 다음 주)' }),
];

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** AccInfo XML(정상 · 데이터 없음 · 오류) */
export function accXml(rows = ACC_ROWS, { code = 'INFO-000', msg = '정상 처리되었습니다', total = rows.length } = {}) {
  if (code !== 'INFO-000') return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<RESULT><CODE>${code}</CODE><MESSAGE><![CDATA[${msg}]]></MESSAGE></RESULT>`;
  const body = rows.map((r) => `<row>${Object.entries(r).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</row>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<AccInfo>\n<list_total_count>${total}</list_total_count>\n<RESULT>\n<CODE>INFO-000</CODE>\n<MESSAGE><![CDATA[${msg}]]></MESSAGE>\n</RESULT>\n${body}\n</AccInfo>`;
}

/** fetch 대신 쓰는 가짜 돌발정보 서버. calls에 요청 URL을 남깁니다. fail(url)이 값을 돌려주면 그 응답을 씁니다. */
export function fakeAccidentFetch({ rows = ACC_ROWS, fail } = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const custom = fail && (await fail(u));
    if (custom) return custom;
    if (!/\/xml\/AccInfo\/\d+\/\d+\/?$/.test(u.pathname)) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => accXml(rows) };
  };
  fn.calls = calls;
  return fn;
}
