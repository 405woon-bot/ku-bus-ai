// 텍스트로 붙여 넣은 시간표 → 수업 목록. 한 줄에 수업 하나(같은 수업이 여러 요일이면 요일마다 항목 생성).
// 지원 예:
//   자료구조 월 09:00-10:15 공학관 301
//   운영체제 / 화,목 10:30~11:45 / 미래관 B102
//   웹프로그래밍 수 3-4교시 북악관 605
//   데이터베이스 월1,2 수3 법학관 201       (포털식: 요일+교시)
//   캡스톤디자인 금 13시-15시50분 미래관 409
import { BUILDINGS } from './campusData.js';
import { toHHMM } from './time.js';

const DAY = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4 };
/** 교시표 가정: n교시 = 09:00 + (n−1)시간, 50분 수업. 실제 학사 교시표로 바꿔 쓰세요. */
export const PERIODS = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, start: 540 + i * 60, end: 590 + i * 60 }));

const BUILDING_NAMES = BUILDINGS.map((b) => b.name).concat(['글로벌센터']).sort((a, b) => b.length - a.length);
const canonical = (n) => (n === '글로벌센터' ? '글로벌 센터' : n);

function periodRange(nums, periods) {
  const ps = nums.map((n) => periods.find((p) => p.n === n)).filter(Boolean);
  if (!ps.length) return null;
  return { start: Math.min(...ps.map((p) => p.start)), end: Math.max(...ps.map((p) => p.end)) };
}
function expandNums(s) { // "1,2" "3-4" "1~3"
  const out = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(n);
  }
  return out;
}

export function parseTimetableText(text, { periods = PERIODS } = {}) {
  const out = [];
  String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((raw, line) => {
    for (const e of parseLine(raw, periods)) out.push({ ...e, line: line + 1, raw });
  });
  return out;
}

function parseLine(raw, periods) {
  let s = ' ' + raw.replace(/[|/\t]/g, ' ').replace(/[–—~∼〜]/g, '-').replace(/\s+/g, ' ').trim() + ' ';
  let cut = s.length; // 과목명은 처음 나온 요일/시간 표현 앞까지
  const mark = (idx) => { cut = Math.min(cut, idx); };

  // 건물·강의실
  let building = '', room = '';
  for (const name of BUILDING_NAMES) {
    const i = s.indexOf(name);
    if (i < 0) continue;
    building = canonical(name);
    const after = s.slice(i + name.length).match(/^\s*([A-Za-z]?\d{2,4}[A-Za-z]?)\s*호?/);
    if (after) room = after[1];
    s = s.slice(0, i) + ' '.repeat(name.length + (after ? after[0].length : 0)) + s.slice(i + name.length + (after ? after[0].length : 0));
    break;
  }
  if (!building) {
    const m = s.match(/\s([가-힣A-Za-z]+관)\s*([A-Za-z]?\d{2,4}[A-Za-z]?)?\s*호?(?=\s)/);
    if (m) { building = m[1]; room = m[2] || ''; s = s.replace(m[0], ' '.repeat(m[0].length)); }
  }

  const slots = []; // { days:[], start, end }
  // (1) 포털식 "월1,2 수3"
  const compact = [...s.matchAll(/\s([월화수목금])\s?(\d{1,2}(?:\s*[,-]\s*\d{1,2})*)(?=\s)/g)];
  if (compact.length && !/교시|:\d{2}|시/.test(s.slice(compact[0].index))) {
    for (const m of compact) {
      const r = periodRange(expandNums(m[2]), periods); mark(m.index);
      if (r) slots.push({ days: [DAY[m[1]]], ...r });
    }
  } else {
    // (2) 요일 토큰: "월", "화목", "화,목", "화·목", "월요일"
    const dm = s.match(/\s((?:[월화수목금](?:요일)?\s*[,·]?\s*)+)(?=\s|\d)/);
    const days = dm ? [...new Set([...dm[1].replace(/요일/g, '')].filter((c) => c in DAY).map((c) => DAY[c]))] : [];
    if (dm) mark(dm.index);
    // (3) 시간 범위 "09:00-10:15", "9시-10시30분"
    const tm = s.match(/(\d{1,2})(?::(\d{2})|시(?:\s*(\d{1,2})분)?)\s*-\s*(\d{1,2})(?::(\d{2})|시(?:\s*(\d{1,2})분)?)/);
    // (4) 교시 "3-4교시", "3,4교시", "1교시"
    const pm = s.match(/(\d{1,2}(?:\s*[,-]\s*\d{1,2})*)\s*교시/);
    let range = null;
    if (tm) {
      mark(tm.index);
      range = { start: +tm[1] * 60 + +(tm[2] || tm[3] || 0), end: +tm[4] * 60 + +(tm[5] || tm[6] || 0) };
    } else if (pm) { mark(pm.index); range = periodRange(expandNums(pm[1]), periods); }
    if (days.length && range) slots.push({ days, ...range });
    else return [{ ok: false, error: !days.length ? '요일을 찾지 못했어요 (예: 월, 화목)' : '시간이나 교시를 찾지 못했어요 (예: 09:00-10:15, 3-4교시)', name: raw.slice(0, 20), building, room }];
  }

  const name = s.slice(0, cut).replace(/[,·\-()[\]]/g, ' ').replace(/\s+/g, ' ').trim() || '수업';
  const res = [];
  for (const sl of slots) for (const day of sl.days) {
    const ok = sl.end > sl.start && sl.start >= 360 && sl.end <= 1380;
    res.push({ ok, error: ok ? '' : '시작·종료 시각을 확인하세요', name, day, start: toHHMM(sl.start), end: toHHMM(sl.end), building, room });
  }
  return res;
}
