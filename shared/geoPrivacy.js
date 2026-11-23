// v2.2.3 위치 저장 정밀도: GPS로 고른 출발지(kind 'gps')는 저장할 때 약 100m 칸(위도 · 경도 소수 셋째 자리)으로 반올림합니다.
//   위도 0.001° ≈ 111m, 경도 0.001° ≈ 88m(서울) → 반올림으로 움직이는 거리는 최대 약 ±55m · ±44m(대각선 약 70m)
//   · 이름으로 고른 역 · 정류장(kind 'stop')은 누구나 아는 정류장 좌표라 그대로 둡니다.
//   · 경로 계산 요청(ODsay) · 근처 정류장 찾기(서울시)에는 그 순간의 정확한 좌표를 쓰고, 그 값은 저장하지 않습니다.
//   서버(사용자 기록 · ODsay 검색 결과 저장)가 씁니다.

export const COARSE_DIGITS = 3;
const F = 10 ** COARSE_DIGITS;

/** 약 100m 칸으로 반올림(같은 값을 다시 넣어도 같음) */
export const coarse = (v) => Math.round(Number(v) * F) / F;
/** 이미 칸 값인지(소수 셋째 자리까지만) */
export const isCoarse = (v) => Number.isFinite(Number(v)) && coarse(v) === Number(v);

/** GPS 출발지인데 아직 칸보다 정밀한 좌표인지 */
export function isPreciseGps(o) {
  if (!o || typeof o !== 'object' || o.kind !== 'gps') return false;
  const lat = Number(o.lat), lon = Number(o.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && !(isCoarse(lat) && isCoarse(lon));
}

/** 저장용 출발지: GPS면 위도 · 경도만 칸으로(다른 값은 그대로), 역 · 정류장이나 이미 칸이면 같은 객체 그대로 */
export function coarseOrigin(o) {
  if (!isPreciseGps(o)) return o;
  return { ...o, lat: coarse(o.lat), lon: coarse(o.lon) };
}

/** ODsay 검색 결과를 저장하는 GPS 출발지 키(같은 칸이면 같은 키) — 예전에는 소수 넷째 자리(약 11m) */
export const gpsKey = (lat, lon) => `g:${coarse(lat).toFixed(COARSE_DIGITS)},${coarse(lon).toFixed(COARSE_DIGITS)}`;
