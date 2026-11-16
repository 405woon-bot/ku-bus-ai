// 예시 날씨 — 기상청 초단기실황(getUltraSrtNcst) 응답 항목 형식을 흉내 낸 가상 값입니다(실시간 아님).
// 쓰임: ① 서버에 기상청 키가 없고 버스도 예시 데이터일 때 ② 서버 없이 여는 미리보기 화면 ③ 자동 테스트.
// 화면에는 '예시 데이터 · 실시간 아님'으로 표시합니다.
import { KU_GRID, ncstBase } from '../weather.js';

const VALUES = {
  rain: { PTY: '1', RN1: '1.5', T1H: '7.2', REH: '92', WSD: '2.1' },
  snow: { PTY: '3', RN1: '0.5', T1H: '-1.5', REH: '88', WSD: '1.8' },
  clear: { PTY: '0', RN1: '0', T1H: '9.8', REH: '55', WSD: '1.2' },
};
/**
 * 지금 시각 기준 예시 실황 항목(값은 모두 문자열)
 * @param {number} nowMs
 * @param {'rain'|'snow'|'clear'} [kind='rain']
 */
export function sampleNcstItems(nowMs, kind = 'rain') {
  const { baseDate, baseTime } = ncstBase(nowMs);
  return Object.entries(VALUES[kind] || VALUES.rain).map(([category, obsrValue]) => ({ baseDate, baseTime, category, nx: KU_GRID.nx, ny: KU_GRID.ny, obsrValue }));
}
