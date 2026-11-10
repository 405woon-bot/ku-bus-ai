// 강의 목록(courses.json — tools/fetch_courses.py가 수강신청 사이트 공개 강좌조회에서 만든 파일) 검색과
// '시간표 수업'으로 바꾸기. 서버(/api/courses)와 화면(미리보기 샘플)이 이 코드를 함께 씁니다.
//
// courses.json 한 건: { id, code, section, name, professor, credits, category, dayNight, grades, department,
//                       times: [{ day(0=월…5=토, 6=일), start "HH:MM", end "HH:MM", room "미래관3층38호실" }], timeText }
import { BUILDINGS } from './campusData.js';
import { toMin } from './time.js';

export const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

/** 검색용 글자 정리: 띄어쓰기·기호 무시, 로마 숫자(Ⅱ·II)와 아라비아 숫자(2)를 같게 */
export function normalizeQuery(s) {
  return String(s ?? '')
    .replace(/[Ⅰⅰ]/g, '1').replace(/[Ⅱⅱ]/g, '2').replace(/[Ⅲⅲ]/g, '3').replace(/[Ⅳⅳ]/g, '4')
    .toLowerCase()
    .replace(/[\s·.,()[\]\-_/&+]/g, '')
    .replace(/iv/g, '4').replace(/iii/g, '3').replace(/ii/g, '2').replace(/i$/, '1');
}

/**
 * 과목명 · 교수명 · 교과목번호로 찾기. 과목명이 검색어로 시작하는 것 → 들어 있는 것 → 교수명 → 번호 순, 같으면 이름·분반 순
 * @returns {Array} 강의 목록(최대 limit개)
 */
export function searchCourses(list, q, { limit = 30 } = {}) {
  const nq = normalizeQuery(q);
  if (!nq) return [];
  const scored = [];
  for (const c of list || []) {
    const nn = normalizeQuery(c.name);
    const score = nn === nq ? 0 : nn.startsWith(nq) ? 1 : nn.includes(nq) ? 2
      : normalizeQuery(c.professor).includes(nq) ? 3 : String(c.code || '').startsWith(String(q).trim()) ? 4 : -1;
    if (score >= 0) scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'ko') || String(a[1].section).localeCompare(String(b[1].section)));
  return scored.slice(0, limit).map((x) => x[1]);
}

const BUILDING_NAMES = BUILDINGS.map((b) => b.name).sort((a, b) => b.length - a.length);
const squash = (s) => String(s ?? '').replace(/\s/g, '');

/** "미래관3층38호실" → { building: '미래관', room: '338' } · 건물을 모르면 앞쪽 글자를 건물로 */
export function splitRoom(roomName) {
  const s = String(roomName ?? '').trim();
  if (!s) return { building: '', room: '' };
  const hit = BUILDING_NAMES.find((n) => squash(s).startsWith(squash(n)));
  let building, rest;
  if (hit) {
    // 띄어쓰기가 달라도 건물 이름 길이만큼(공백 제외) 잘라 냄
    let k = 0, i = 0;
    const target = squash(hit).length;
    while (i < s.length && k < target) { if (!/\s/.test(s[i])) k++; i++; }
    building = hit; rest = s.slice(i).trim();
  } else {
    // 건물표에 없는 이름: '…관/센터/홀'까지 또는 숫자 앞까지를 건물로
    const m = /^(.+?(?:관|센터|홀))\s*(.*)$/.exec(s) || /^([^\d\s]+?)\s*((?:B|지하)?\d.*)$/.exec(s);
    if (!m) return { building: s, room: '' };
    building = m[1]; rest = m[2];
  }
  const fr = /^(B|지하)?(\d+)층\s*(\d+)호실?$/.exec(rest);
  const room = fr ? `${fr[1] ? 'B' : ''}${fr[2]}${fr[3].padStart(2, '0')}` : rest.replace(/호실$/, '호');
  return { building, room };
}

/** 강의 → 시간표 수업(만나는 요일·시간마다 하나). 일요일·시간 미정은 넣지 않음 */
export function courseToClasses(course, { color } = {}) {
  return (course.times || []).filter((t) => t.day >= 0 && t.day <= 5).map((t) => {
    const { building, room } = splitRoom(t.room);
    return {
      name: course.name, day: t.day, start: t.start, end: t.end, building, room,
      courseId: course.id, professor: course.professor || '', section: course.section || '', ...(color != null ? { color } : {}),
    };
  });
}

/** 이미 시간표에 넣은 강의인지 */
export const isCourseAdded = (course, classes) => (classes || []).some((c) => c.courseId === course.id);

/** 이 강의와 시간이 겹치는 시간표 수업(같은 강의는 제외) */
export function courseConflicts(course, classes) {
  const out = [];
  for (const c of classes || []) {
    if (c.courseId && c.courseId === course.id) continue;
    const hit = (course.times || []).some((t) => t.day === c.day && toMin(t.start) < toMin(c.end) && toMin(c.start) < toMin(t.end));
    if (hit && !out.some((x) => x.name === c.name)) out.push(c);
  }
  return out;
}

/** 시간표 수업이 어느 과목인지: 수업 검색으로 넣은 강의는 강의 번호, 직접 넣은 수업은 과목명 */
export const courseKeyOf = (c) => (c.courseId ? `id:${c.courseId}` : `name:${c.name}`);

/**
 * 이 강의와 겹치는 '과목' 목록 — 과목마다 모든 요일의 수업(빼면 함께 빠짐)과 실제로 겹치는 칸.
 * 시간표에 겹치는 수업이 남지 않도록, 추가하기 전에 이 과목들을 빼고 넣습니다.
 * @returns {Array<{ key, name, classes: object[], overlaps: object[], timeText: string }>}
 */
export function conflictGroups(course, classes) {
  const keys = [...new Set(courseConflicts(course, classes).map(courseKeyOf))];
  // courseConflicts는 과목마다 한 칸만 돌려주므로, 같은 과목의 겹치는 칸을 모두 다시 모음
  return keys.map((key) => {
    const all = (classes || []).filter((c) => courseKeyOf(c) === key).sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
    const overlaps = all.filter((c) => (course.times || []).some((t) => t.day === c.day && toMin(t.start) < toMin(c.end) && toMin(c.start) < toMin(t.end)));
    return { key, name: all[0].name, classes: all, overlaps, timeText: all.map((c) => `${DAY_NAMES[c.day]} ${c.start}-${c.end}`).join(' · ') };
  });
}

/** 겹치는 과목을 빼고 강의를 넣은 시간표(빠질 수업 id 목록과 함께) */
export function replaceConflicts(course, classes) {
  const groups = conflictGroups(course, classes);
  const removeIds = new Set(groups.flatMap((g) => g.classes.map((c) => c.id)));
  return { groups, removeIds: [...removeIds], kept: (classes || []).filter((c) => !removeIds.has(c.id)) };
}

/** "월 15:00-16:30 · 목 16:30-18:00" (파일에 timeText가 없을 때) */
export function courseTimeText(course) {
  if (course.timeText) return course.timeText;
  if (!course.times?.length) return '시간 미정';
  return course.times.map((t) => `${DAY_NAMES[t.day]} ${t.start}-${t.end}`).join(' · ');
}

/** 강의실 표시: 요일마다 같으면 한 번만 — "미래관 338" */
export function courseRoomText(course) {
  const rooms = [...new Set((course.times || []).map((t) => { const r = splitRoom(t.room); return [r.building, r.room].filter(Boolean).join(' '); }).filter(Boolean))];
  return rooms.join(', ');
}
