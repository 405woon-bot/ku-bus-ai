// 예시 돌발정보 — 서울 열린데이터광장 실시간 돌발정보(AccInfo) 응답 형식을 흉내 낸 가상 값입니다(실시간 아님).
// 쓰임: ① 서버가 예시 데이터로 동작할 때(버스 실시간 실패) ② 서버 없이 여는 미리보기 화면 ③ 자동 테스트.
// 위치는 국민대 주변 샘플 정류장(shared/samples/seoulSample.js) 근처이고, 이름 · 시각은 지어낸 값입니다. 화면에는 '예시 데이터 · 실시간 아님'으로 표시합니다.
import { kstDate, kstMidnight, kstTime, latLonToTm } from '../incidents.js';

const HOUR = 3600_000, DAY = 24 * HOUR;
const at = (lat, lon) => { const { x, y } = latLonToTm(lat, lon); return { grs80tm_x: x.toFixed(4), grs80tm_y: y.toFixed(4) }; };
const when = (start, end) => ({ occr_date: kstDate(start), occr_time: kstTime(start), exp_clr_date: kstDate(end), exp_clr_time: `${kstTime(end)}00` });

/**
 * 지금 시각(nowMs) 기준 예시 돌발정보(AccInfo 행 형식, 값은 모두 문자열)
 * @param {number} nowMs
 * @param {'all'|'campus'|'none'} [scenario='all'] 미리보기에서 고르는 상황 — all: 경로 위 공사 + 국민대 근처 행사, campus: 행사만, none: 없음
 */
export function sampleIncidentRows(nowMs, scenario = 'all') {
  if (scenario === 'none') return [];
  const day0 = kstMidnight(nowMs);
  // 청덕초등학교입구 ~ 국민대학교앞 사이(샘플 경로 위)
  const work = {
    acc_id: 'SAMPLE-1', ...when(day0 - 6 * DAY + 9 * HOUR, day0 + 104 * DAY + 23 * HOUR + 59 * 60_000), acc_type: 'A04', acc_dtype: '04B01', link_id: '0000000001',
    ...at(37.60955, 126.99863), acc_info: '정릉로 하수관 정비공사(예시)-장소 : 청덕초등학교입구~국민대학교앞(예시)-통제 : 국민대 방향 1개 차로 통제', acc_road_code: '000',
  };
  // 국민대에서 약 550m(경로에서는 300m 넘게 떨어짐) · 오늘 10:00~12:00
  const event = {
    acc_id: 'SAMPLE-2', ...when(day0 + 10 * HOUR, day0 + 12 * HOUR), acc_type: 'A10', acc_dtype: '10A01', link_id: '0000000002',
    ...at(37.6140, 126.9925), acc_info: '거리 행사(예시)-장소 : 국민대 근처(예시)-통제 : 일부 차로 통제', acc_road_code: '000',
  };
  // 걸러지는 예: 멀리 떨어진 공사(봉은교, 실제 응답 샘플의 좌표) · 보여 주지 않는 종류(A02 차량고장)
  const far = {
    acc_id: 'SAMPLE-3', ...when(day0 - 30 * DAY + 10 * HOUR, day0 + 100 * DAY), acc_type: 'A04', acc_dtype: '04B01', link_id: '1220031600',
    grs80tm_x: '206076.7132692197', grs80tm_y: '446245.6950463236', acc_info: '봉은교 구조개선공사(예시)-장소 : 봉은교-통제 : 양방향 전면통제', acc_road_code: '009',
  };
  const other = {
    acc_id: 'SAMPLE-4', ...when(nowMs - HOUR, nowMs + HOUR), acc_type: 'A02', acc_dtype: '02A01', link_id: '0000000004',
    ...at(37.6089, 127.0015), acc_info: '차량 고장(예시)', acc_road_code: '000',
  };
  return scenario === 'campus' ? [event, far] : [work, event, far, other];
}
