import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimetableText } from './parseTimetableText.js';
const pick = (e) => ({ name: e.name, day: e.day, start: e.start, end: e.end, building: e.building, room: e.room, ok: e.ok });

test('시간 범위·건물·강의실', () => {
  assert.deepEqual(parseTimetableText('자료구조 월 09:00-10:15 공학관 301').map(pick),
    [{ name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '공학관', room: '301', ok: true }]);
});
test('여러 요일·구분자·영문 강의실', () => {
  const r = parseTimetableText('운영체제 / 화,목 10:30~11:45 / 미래관 B102').map(pick);
  assert.deepEqual(r.map((e) => e.day), [1, 3]);
  assert.equal(r[0].name, '운영체제'); assert.equal(r[0].room, 'B102'); assert.equal(r[1].end, '11:45');
});
test('교시 표기', () => {
  const [e] = parseTimetableText('웹프로그래밍 수 3-4교시 북악관 605').map(pick);
  assert.deepEqual(e, { name: '웹프로그래밍', day: 2, start: '11:00', end: '12:50', building: '북악관', room: '605', ok: true });
});
test('포털식 요일+교시', () => {
  const r = parseTimetableText('데이터베이스 월1,2 수3 법학관 201').map(pick);
  assert.deepEqual(r.map((e) => [e.day, e.start, e.end]), [[0, '09:00', '10:50'], [2, '11:00', '11:50']]);
  assert.equal(r[0].name, '데이터베이스');
});
test('한글 시각 표기와 요일 글자가 든 과목명', () => {
  assert.deepEqual(parseTimetableText('캡스톤디자인 금 13시-15시50분 미래관 409').map(pick)[0],
    { name: '캡스톤디자인', day: 4, start: '13:00', end: '15:50', building: '미래관', room: '409', ok: true });
  const [a] = parseTimetableText('수학 화 9:00-10:15 과학관').map(pick);
  assert.equal(a.name, '수학'); assert.equal(a.day, 1);
  const [b] = parseTimetableText('금융공학 금 13:00-14:15 경영관 301').map(pick);
  assert.equal(b.name, '금융공학'); assert.equal(b.day, 4);
});
test('해석할 수 없는 줄은 오류로 돌려준다', () => {
  const [e] = parseTimetableText('그냥 메모');
  assert.equal(e.ok, false); assert.match(e.error, /요일/);
});
