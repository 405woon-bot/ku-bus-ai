// 노선별 정체 구간 매핑표 — 가장 느린 구간(정류장 A → B)이 어느 도로인지 사람이 읽는 원인 문구로 바꿉니다.
// ⚠ 예시 표입니다. 정류장 이름은 OSM 정류장 자료(© OpenStreetMap contributors)를 참고했고, 노선이 실제로 이 정류장을
//    이 순서로 지나는지는 서울시 노선 정보(getStaionByRoute 응답)로 확인한 뒤 고쳐 쓰세요.
//    표에 없는 구간은 "청덕초등학교입구→국민대학교앞 구간"처럼 정류장 이름으로 안내합니다.

/** @type {Record<string, Array<{ road:string, stations:string[] }>>} 노선번호 → 도로별 정류장 목록 */
export const CORRIDORS = {
  171: [{ road: '정릉로', stations: ['고려대사범대학부속고등학교', '청덕초등학교입구', '국민대학교앞'] }],
  1711: [{ road: '정릉로', stations: ['청덕초등학교입구', '국민대앞'] }],
  1112: [{ road: '정릉로9길', stations: ['청덕초등학교입구', '국민대후문'] }],
};

export const SLOW_KMH = 15; // 이보다 느린 구간을 정체로 봄

const norm = (s) => String(s ?? '').replace(/[\s.·()]/g, '');

/**
 * 가장 느린 구간 → 원인 문구
 * @param {string} routeNo
 * @param {{ from:string, to:string, kmh:number, seq?:number }} section
 * @param {{ corridor?:string, corridorSeq?:[number,number] }} [route] 사용자 노선 설정(예전 방식 호환)
 * @returns {{ text:string, road:string|null, from:string, to:string, kmh:number } | null}
 */
export function causeFromSection(routeNo, section, route = {}, table = CORRIDORS) {
  if (!section || !(section.kmh < SLOW_KMH)) return null;
  const a = norm(section.from), b = norm(section.to);
  for (const c of table[String(routeNo)] || []) {
    const names = c.stations.map(norm);
    if (names.includes(a) && names.includes(b)) return { text: c.road, road: c.road, from: section.from, to: section.to, kmh: section.kmh };
  }
  const [s0, s1] = Array.isArray(route.corridorSeq) ? route.corridorSeq : [];
  if (route.corridor && Number.isFinite(s0) && section.seq >= s0 && section.seq <= s1) {
    return { text: route.corridor, road: route.corridor, from: section.from, to: section.to, kmh: section.kmh };
  }
  return { text: `${section.from}→${section.to} 구간`, road: null, from: section.from, to: section.to, kmh: section.kmh };
}
