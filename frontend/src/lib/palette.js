// 수업 블록 색(에브리타임처럼 과목마다 다른 색). 지정 팔레트의 도로·녹지·건물·파랑 계열을 바탕으로 만든 파스텔 8색.
export const COURSE_COLORS = [
  { bg: '#FECA7D', ink: '#5A3B00' },
  { bg: '#D0E2C2', ink: '#2F4A22' },
  { bg: '#C7DAFB', ink: '#163A80' },
  { bg: '#F7CFC8', ink: '#6E2219' },
  { bg: '#DCD3F2', ink: '#3C2C6E' },
  { bg: '#C3E5DF', ink: '#1C514A' },
  { bg: '#F2D3E4', ink: '#6A2450' },
  { bg: '#DCE9F1', ink: '#28485E' },
];
const hash = (s) => [...String(s || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
/** 색 번호가 없으면(서버·가져오기 데이터) 과목명으로 정해진 색 */
export const courseColor = (i, name) => {
  const n = COURSE_COLORS.length, k = Number.isFinite(i) ? i : hash(name);
  return COURSE_COLORS[((k % n) + n) % n];
};
/** 같은 과목명은 같은 색 */
export function colorIndexFor(name, classes) {
  const same = classes.find((c) => c.name === name);
  if (same) return same.color;
  const used = new Set(classes.map((c) => c.color));
  for (let i = 0; i < COURSE_COLORS.length; i++) if (!used.has(i)) return i;
  return classes.length % COURSE_COLORS.length;
}
/** 서울 버스 관례: 간선 파랑, 지선 초록 */
export const routeColor = (type) => ({ 지선: '#3E9B4F', 마을: '#3E9B4F', 광역: '#D0342C', 순환: '#C98A00' }[type] || '#4A92EB');
