// 강의 목록(courses.json) — tools/fetch_courses.py가 수강신청 사이트 공개 강좌조회에서 만든 파일을 서버 시작 때 읽어
// '수업 검색'(GET /api/courses)에 씁니다. 파일이 없으면 검색은 안내 메시지와 함께 503.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_COURSES_FILE = fileURLToPath(new URL('../courses/courses.json', import.meta.url));

/** @returns {{ meta: { available:boolean, year?, semester?, semesterName?, count?, fetchedAt? }, courses: Array }} */
export function loadCourses(file = DEFAULT_COURSES_FILE, log = console) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const courses = (Array.isArray(j) ? j : j.courses || []).filter((c) => c && c.id && c.name);
    return { meta: { ...(Array.isArray(j) ? {} : j.meta || {}), count: courses.length, available: true }, courses };
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn?.(`[courses] ${file}: ${e.message}`);
    return { meta: { available: false, count: 0 }, courses: [] };
  }
}
