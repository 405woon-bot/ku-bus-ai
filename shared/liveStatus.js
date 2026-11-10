// 실시간 데이터 출처·폴백 이유 — 백엔드 응답과 화면 배지가 같은 문구를 씁니다.

/** source: 'seoul' = 서울시 실시간, 'mock' = 예시(모의) 데이터 */
export const REASON_TEXT = Object.freeze({
  'no-key': 'API 키 없음',
  quota: '호출 한도 초과',
  auth: '인증키 오류',
  parse: '응답 해석 오류',
  network: '네트워크 오류',
  timeout: '응답 시간 초과',
  http: '서울시 서버 오류',
  temporary: '실시간 정보 일시 중단',
  api: '서울시 API 오류',
  config: '승차 정류장 미설정',
  server: '우리 서버 연결 안 됨',
  demo: '데모',
});
export const reasonText = (r) => REASON_TEXT[r] || (r ? String(r) : '');

/** 폴백 이유가 여러 개일 때 화면에 보여 줄 대표 이유(사용자가 고칠 수 있는 것 우선) */
const PRIORITY = ['no-key', 'auth', 'quota', 'config', 'parse', 'timeout', 'network', 'http', 'temporary', 'api'];
export function mainReason(kinds) {
  const set = new Set(kinds.filter(Boolean));
  return PRIORITY.find((k) => set.has(k)) || [...set][0] || null;
}
