// v2.5.2 실시간 지하철 줄 읽기 점검: 방면은 마지막 '-' 뒤('-2행 - 일원방면' → '일원') · 이름에 '-'가 없으면 예전 규칙과 같은 답(무작위 2만 가지) ·
//   종착이 역 이름이 아니면('-2'처럼 숫자 · 기호뿐) 쓰지 않고 dest로 셈 · 빈 칸 · 정상 이름은 그대로 · 그 밖의 열차 고르기는 예전과 똑같음(무작위 2만 가지).
//   열차는 모두 예시입니다(2026-11-26 00:08 실제 응답에서 본 모양을 본뜸).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIR_RE, liveLine, oddDest, parseSubwayRow, stationKey, trainsForLeg } from './subwayArrivals.js';

const OLD_DIR = /[-–]\s*(.+?)\s*방면/; // v2.5.1까지(처음 '-' 뒤를 읽음) — 비교용
const now = Date.parse('2026-11-26T00:08:44+09:00');
const two = (n) => String(n).padStart(2, '0');
const recptn = (ms) => { const d = new Date(ms + 9 * 3600_000); return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
const raw = (o) => ({ subwayId: '1003', updnLine: '상행', btrainSttus: '일반', arvlCd: '99', barvlDt: '330', arvlMsg2: '5분 30초 후 (오금)', recptnDt: recptn(now - 20_000), lstcarAt: '0', ...o });
const LEG3 = { subwayId: '1003', lineName: '수도권 3호선', next: '일원', stations: ['수서', '일원', '대청', '학여울', '대치', '도곡'] };
// 작은 결정적 난수(매번 같은 시험)
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (r, a) => a[Math.floor(r() * a.length)];

test("방면: 마지막 '-' 뒤를 읽음 — '-2행 - 일원방면' → 일원 · 급행 · 막차 · 괄호 · 띄어쓰기 없음 · 긴 줄표 · 종착역 자신", () => {
  const cases = [['-2행 - 일원방면', '일원'], ['광운대행 - 시청방면', '시청'], ['김포공항행 - 개화방면 (급행)', '개화'], ['검암행 - 공덕방면 (막차)', '공덕'],
    ['상봉행 - 중랑방면 (막차)', '중랑'], ['용산행 - 신촌(경의중앙선)방면', '신촌(경의중앙선)'], ['광운대행-시청방면', '시청'], ['인천공항2터미널행 – 공덕방면', '공덕'],
    ['수서행 - 수서방면', '수서'], ['샛강행', ''], ['', '']];
  for (const [s, want] of cases) assert.equal((DIR_RE.exec(s) || [])[1] || '', want, s);
  assert.equal(parseSubwayRow(raw({ trainLineNm: '-2행 - 일원방면', bstatnNm: '-2' }), now).next, '일원');
  assert.equal((OLD_DIR.exec('-2행 - 일원방면') || [])[1], '2행 - 일원', 'v2.5.1까지는 이렇게 읽었음');
});

test("방면: 종착 · 방면 역 이름에 '-'가 없으면 예전 규칙과 같은 답(무작위 2만 가지)", () => {
  const r = rng(20261126);
  const names = ['대화', '성수', '신촌(경의중앙선)', '인천공항2터미널', '김포공항', '오금', '북한산우이', '서울', 'A1', '2', '광운대', '상왕십리', '디지털미디어시티'];
  const seps = [' - ', '-', ' -', '- ', ' – ', '–', '  -  '];
  const tails = ['', ' (급행)', ' (막차)', '(급행)', ' (막차) (급행)'];
  let n = 0;
  for (let k = 0; k < 20000; k++) {
    const s = `${pick(r, names)}행${pick(r, seps)}${pick(r, names)}방면${pick(r, tails)}`;
    assert.equal((DIR_RE.exec(s) || [])[1] || '', (OLD_DIR.exec(s) || [])[1] || '', s);
    n++;
  }
  assert.equal(n, 20000);
});

test("종착이 역 이름이 아니면(숫자 · 기호뿐) 쓰지 않고 dest로 셈 · 빈 칸 · 정상 이름은 지금처럼 · 반대 방향은 세지 않음", () => {
  assert.deepEqual(['-2', '2', '-', '0', ' -2 ', '?', '', null, undefined, '대화', 'GTX', '오금(3호선)', '인천공항2터미널'].map(oddDest),
    [true, true, true, true, true, true, false, false, false, false, false, false, false]);
  const rows = [
    raw({ trainLineNm: '-2행 - 일원방면', bstatnNm: '-2', barvlDt: '330' }),
    raw({ trainLineNm: '대화행 - 일원방면', bstatnNm: '대화', barvlDt: '540', arvlMsg2: '9분 후 (오금)' }),
    raw({ trainLineNm: '행 - 일원방면', bstatnNm: '', barvlDt: '700', arvlMsg2: '11분 후' }),
    raw({ trainLineNm: '-2행 - 오금방면', bstatnNm: '-2', updnLine: '하행', barvlDt: '200' }),
  ].map((x) => parseSubwayRow(x, now));
  const drops = {};
  const kept = trainsForLeg(rows, LEG3, drops);
  assert.deepEqual(kept.map((t) => [t.dest, t.etaSec]), [['대화', 520], ['', 680]], '빈 칸 종착은 지금처럼 씀(따로 보지 않음)');
  assert.deepEqual(drops, { dest: 1 }, "같은 방향의 '-2'만 dest로 셈(반대 방향은 원래 빠지는 열차라 세지 않음)");
});

test('열차 고르기: 종착이 역 이름이 아닌 줄만 빠지고 나머지는 예전과 똑같음(무작위 2만 가지)', () => {
  // v2.5.1 trainsForLeg 그대로(비교용 — 열차 종류는 모두 '일반'이라 종류 규칙은 두 쪽 모두 통과)
  const oldTrains = (rows, leg) => {
    const group = liveLine(leg?.subwayId)?.group || 'metro';
    const next = stationKey(leg?.next), stations = (leg?.stations || []).map(stationKey), last = stations.length - 1;
    const updn = !next && group === 'metro' && leg?.subwayId && leg.subwayId !== '1002' ? ({ 1: '상행', 2: '하행' }[leg.wayCode] || null) : null;
    return rows.filter((x) => {
      if (leg?.subwayId) { if (!x.subwayId) return false; if (x.subwayId !== leg.subwayId) return false; }
      if (next) { if (!stationKey(x.next)) return false; if (stationKey(x.next) !== next) return false; } else if (!updn) return false; else if (x.updn !== updn) return false;
      const di = stations.indexOf(stationKey(x.dest));
      return !(di >= 0 && di < last);
    }).sort((a, b) => a.etaSec - b.etaSec);
  };
  const r = rng(52);
  const legs = [LEG3, { subwayId: '1002', lineName: '수도권 2호선', next: '신촌', stations: ['홍대입구', '신촌', '이대'] },
    { subwayId: '1004', lineName: '수도권 4호선', next: '', wayCode: 1, stations: ['서울역', '회현', '명동'] }, { subwayId: '1075', lineName: '수인분당선', next: '청량리', stations: ['왕십리', '청량리'] }];
  const dests = ['대화', '성수', '-2', '2', '', '일원', '도곡', '수서', '?', '청량리', '왕십리', '오금'];
  for (let k = 0; k < 20000; k++) {
    const leg = pick(r, legs);
    const rows = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, j) => ({
      subwayId: pick(r, [leg.subwayId, leg.subwayId, '1001', '']), updn: pick(r, ['상행', '하행', '내선']), next: pick(r, ['일원', '신촌', '청량리', '오금', '']),
      dest: pick(r, dests), etaSec: Math.floor(r() * 900) + j, approx: false, express: false, type: '일반', last: false, code: 99, msg: '',
    }));
    const expect = oldTrains(rows, leg).filter((x) => !oddDest(x.dest));
    assert.deepEqual(trainsForLeg(rows, leg), expect, JSON.stringify({ leg: leg.subwayId, rows }));
  }
});
