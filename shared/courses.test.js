import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictGroups, courseConflicts, courseRoomText, courseTimeText, courseToClasses, isCourseAdded, normalizeQuery, replaceConflicts, searchCourses, splitRoom } from './courses.js';
import { SAMPLE_COURSES } from './samples/sampleCourses.js';

test('검색: 과목명 앞부분 → 포함 → 교수명 → 과목번호, 띄어쓰기·로마 숫자 무시', () => {
  assert.deepEqual(searchCourses(SAMPLE_COURSES, '회로이론').map((c) => `${c.name} ${c.section}`), ['회로이론I 01', '회로이론I 02', '회로이론II 01', '회로이론II 02', '회로이론II 03', '회로이론II 04']);
  assert.deepEqual(searchCourses(SAMPLE_COURSES, '회로 이론 2').map((c) => c.section), ['01', '02', '03', '04']);
  assert.equal(normalizeQuery('회로이론Ⅱ'), normalizeQuery('회로이론II'));
  assert.ok(searchCourses(SAMPLE_COURSES, '윤교수').every((c) => c.professor === '윤교수'));
  assert.deepEqual(searchCourses(SAMPLE_COURSES, 'S000204').map((c) => c.name), ['데이터베이스', '데이터베이스']);
  assert.deepEqual(searchCourses(SAMPLE_COURSES, ''), []);
  assert.equal(searchCourses(SAMPLE_COURSES, '자', { limit: 2 }).length, 2);
});

test('강의실 이름 → 건물·호실: 캠퍼스 건물표와 맞춤', () => {
  assert.deepEqual(splitRoom('미래관3층38호실'), { building: '미래관', room: '338' });
  assert.deepEqual(splitRoom('공학관 4층 01호실'), { building: '공학관', room: '401' });
  assert.deepEqual(splitRoom('산학협력관B1층03호실'), { building: '산학협력관', room: 'B103' });
  assert.deepEqual(splitRoom('7호관201호'), { building: '7호관', room: '201호' });
  assert.deepEqual(splitRoom('온라인'), { building: '온라인', room: '' });
  assert.deepEqual(splitRoom(''), { building: '', room: '' });
});

test('강의 → 시간표 수업(요일마다 하나, 같은 강의 표시), 토요일 포함 · 시간 미정은 없음', () => {
  const c = SAMPLE_COURSES.find((x) => x.name === '회로이론II' && x.section === '01');
  assert.deepEqual(courseToClasses(c, { color: 3 }), [
    { name: '회로이론II', day: 0, start: '15:00', end: '16:30', building: '미래관', room: '338', courseId: c.id, professor: '김교수', section: '01', color: 3 },
    { name: '회로이론II', day: 3, start: '16:30', end: '18:00', building: '미래관', room: '338', courseId: c.id, professor: '김교수', section: '01', color: 3 },
  ]);
  assert.equal(courseToClasses(SAMPLE_COURSES.find((x) => x.name === '현대사회와윤리'))[0].day, 5);
  assert.deepEqual(courseToClasses(SAMPLE_COURSES.find((x) => x.times.length === 0)), []);
  assert.equal(courseTimeText(c), '월 15:00-16:30 · 목 16:30-18:00');
  assert.equal(courseRoomText(c), '미래관 338');
});

test('겹침 · 이미 추가됨', () => {
  const ds = SAMPLE_COURSES.find((x) => x.name === '자료구조' && x.section === '01'); // 월·수 09:00-10:30
  const mine = [{ id: 'a', name: '선형대수', day: 0, start: '10:00', end: '11:00' }, { id: 'b', name: '운영체제', day: 1, start: '09:00', end: '10:00' }];
  assert.deepEqual(courseConflicts(ds, mine).map((c) => c.name), ['선형대수']);
  const added = courseToClasses(ds).map((x, i) => ({ ...x, id: `c${i}` }));
  assert.equal(isCourseAdded(ds, added), true);
  assert.deepEqual(courseConflicts(ds, added), [], '같은 강의끼리는 겹침이 아님');
  assert.deepEqual(courseConflicts(ds, [{ name: '끝나자마자', day: 0, start: '10:30', end: '12:00' }]), [], '끝 = 시작은 겹치지 않음');
});

test('겹치는 과목 빼고 추가: 과목 단위(모든 요일)로 빠지고, 겹치지 않는 수업은 그대로', () => {
  const ds = SAMPLE_COURSES.find((x) => x.name === '자료구조' && x.section === '01'); // 월·수 09:00-10:30
  const mine = [
    { id: 'a1', name: '선형대수', day: 0, start: '10:00', end: '11:00' },             // 월 겹침
    { id: 'a2', name: '선형대수', day: 2, start: '13:00', end: '14:00' },             // 같은 과목의 다른 요일(겹치지 않아도 함께 빠짐)
    { id: 'b1', name: '운영체제', day: 1, start: '09:00', end: '10:00' },             // 겹치지 않음
    { id: 'c1', name: '알고리즘', day: 2, start: '09:30', end: '10:00', courseId: 'X-1' }, // 수 겹침(수업 검색으로 넣은 강의)
    { id: 'c2', name: '알고리즘', day: 4, start: '09:30', end: '10:00', courseId: 'X-1' },
  ];
  const g = conflictGroups(ds, mine);
  assert.deepEqual(g.map((x) => [x.name, x.classes.map((c) => c.id), x.overlaps.map((c) => c.id), x.timeText]), [
    ['선형대수', ['a1', 'a2'], ['a1'], '월 10:00-11:00 · 수 13:00-14:00'],
    ['알고리즘', ['c1', 'c2'], ['c1'], '수 09:30-10:00 · 금 09:30-10:00'],
  ]);
  const r = replaceConflicts(ds, mine);
  assert.deepEqual([r.removeIds, r.kept.map((c) => c.id)], [['a1', 'a2', 'c1', 'c2'], ['b1']]);
  assert.deepEqual(courseConflicts(ds, r.kept), [], '빼고 나면 겹치는 수업 없음');
  assert.deepEqual(replaceConflicts(ds, [{ id: 'z', name: '체육', day: 4, start: '09:00', end: '10:00' }]).removeIds, []);
});
