// 수업 검색 API(/api/courses) — courses.json(tools/fetch_courses.py 결과)과 같은 형식의 샘플로 시험
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { loadCourses } from '../src/courses.js';
import { createMockProvider } from '../src/transit/index.js';
import { SAMPLE_COURSES } from '../../shared/samples/sampleCourses.js';
import { courseToClasses } from '../../shared/courses.js';

const quiet = { warn() {}, info() {} };
const fakePusher = { enabled: false, publicKey: null, send: async () => [] };
async function serve(courses, fn) {
  const app = createApp({ store: createStore(null), provider: createMockProvider(), pusher: fakePusher, courses });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try { await fn(req); } finally { srv.close(); }
}

test('courses.json 읽기: 정보 + 강의 / 파일이 없으면 available false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-'));
  const file = path.join(dir, 'courses.json');
  fs.writeFileSync(file, JSON.stringify({ meta: { year: '2026', semester: '20', semesterName: '2학기', fetchedAt: '2026-11-10T09:00:00+09:00' }, courses: SAMPLE_COURSES }));
  const c = loadCourses(file, quiet);
  assert.deepEqual([c.meta.available, c.meta.count, c.meta.semesterName], [true, SAMPLE_COURSES.length, '2학기']);
  assert.deepEqual(loadCourses(path.join(dir, 'none.json'), quiet).meta, { available: false, count: 0 });
});

test('GET /api/courses: 과목명·교수명 검색, 검색어 없으면 400, 목록이 없으면 503 안내', async () => {
  await serve({ meta: { available: true, year: '2026', semesterName: '2학기', count: SAMPLE_COURSES.length }, courses: SAMPLE_COURSES }, async (req) => {
    const r = await req('GET', '/api/courses?q=회로이론2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.courses.map((c) => c.section), ['01', '02', '03', '04']);
    assert.equal(r.body.courses[0].timeText, '월 15:00-16:30 · 목 16:30-18:00');
    assert.equal((await req('GET', '/api/courses?q=')).status, 400);
    assert.equal((await req('GET', '/api/courses?q=자&limit=3')).body.courses.length, 3);
    assert.equal((await req('GET', '/api/courses/meta')).body.semesterName, '2학기');
  });
  await serve({ meta: { available: false, count: 0 }, courses: [] }, async (req) => {
    const r = await req('GET', '/api/courses?q=회로');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /fetch_courses\.py/);
  });
});

test('수업 검색으로 넣은 강의(토요일 포함)가 시간표 저장·불러오기에서 묶음 번호와 함께 유지', async () => {
  await serve({ meta: { available: false }, courses: [] }, async (req) => {
    const c1 = SAMPLE_COURSES.find((c) => c.name === '회로이론II' && c.section === '01');
    const c2 = SAMPLE_COURSES.find((c) => c.name === '현대사회와윤리');
    const classes = [...courseToClasses(c1, { color: 2 }), ...courseToClasses(c2, { color: 4 })];
    assert.equal((await req('PUT', '/api/me/timetable', { classes })).status, 200);
    const me = (await req('GET', '/api/me')).body;
    assert.deepEqual(me.classes.map((c) => [c.name, c.day, c.start, c.building, c.room, c.courseId, c.section]), [
      ['회로이론II', 0, '15:00', '미래관', '338', c1.id, '01'], ['회로이론II', 3, '16:30', '미래관', '338', c1.id, '01'], ['현대사회와윤리', 5, '10:00', '북악관', '609', c2.id, '01']]);
    assert.equal((await req('PUT', '/api/me/timetable', { classes: [{ ...classes[0], day: 6 }] })).status, 400);
  });
});
