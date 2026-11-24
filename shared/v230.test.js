// v2.3.0 점검: 실시간 허용 목록(19개 노선) · 비상 끄기 읽기 · 노선 묶음별 열차 고르기(직통 · ITX 제외, 애매하면 쓰지 않음) · 뺀 이유 세기.
//   1~9호선은 예전 규칙 그대로인지(직통 · ITX만 더 뺌)도 함께 봅니다. 열차는 모두 예시(실제 운행 정보 아님)입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_LINES, liveLine, liveSupport, parseOffLines, parseSubwayArrivals, parseSubwayRow, trainsForLeg } from './subwayArrivals.js';
import { subwayLine } from './transitPlan.js';

const AT = Date.parse('2026-11-24T08:00:00+09:00');
const RECPTN = '2026-11-24 08:00:00';
/** 서울시 응답 한 줄(원문 형식) — 기본은 공항철도 서울역에서 공덕 방면 일반 열차 */
const raw = (o = {}) => ({ subwayId: '1065', updnLine: '하행', trainLineNm: '인천공항2터미널행 - 공덕방면', statnNm: '서울', btrainSttus: '일반',
  barvlDt: '300', bstatnNm: '인천공항2터미널', recptnDt: RECPTN, arvlMsg2: '5분 후 (공덕)', arvlCd: '99', lstcarAt: '0', ...o });
const rowsOf = (list) => parseSubwayArrivals({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: list }, AT).rows;
const etas = (rows, leg, drops) => trainsForLeg(rows, leg, drops).map((t) => t.etaSec);
// 예시 구간들(shared/transitPlan.js가 만드는 모양)
const AREX = { kind: 'subway', subwayId: '1065', line: '공항철도', lineName: '공항철도', next: '공덕', stations: ['서울역', '공덕', '홍대입구'], wayCode: 2, from: { name: '서울역' } };
const LINE1 = { kind: 'subway', subwayId: '1001', line: '1호선', lineName: '수도권 1호선', next: '남영', stations: ['서울역', '남영', '용산', '노량진'], wayCode: 2, from: { name: '서울역' } };
const UI = { kind: 'subway', subwayId: '1092', line: '우이신설선', lineName: '우이신설선', next: '정릉', stations: ['성신여대입구', '정릉'], wayCode: 1, from: { name: '성신여대입구' } };

test('허용 목록: 19개 노선(1~9호선 metro 9 · 급행/직통/ITX 노선 strict 4 · 급행 없는 노선 plain 6) · 노선 이름 → 번호(transitPlan)와 어긋나지 않음', () => {
  const ids = Object.keys(LIVE_LINES);
  assert.equal(ids.length, 19);
  const byGroup = (g) => ids.filter((id) => LIVE_LINES[id][1] === g).sort();
  assert.deepEqual(byGroup('metro'), ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009']);
  assert.deepEqual(byGroup('strict'), ['1063', '1065', '1067', '1075']);
  assert.deepEqual(byGroup('plain'), ['1032', '1077', '1081', '1092', '1093', '1094']);
  assert.ok(Object.isFrozen(LIVE_LINES) && Object.isFrozen(LIVE_LINES[1065]), '실행 중에 바뀌지 않게');
  // ODsay 노선 이름 → 번호(transitPlan) → 모두 허용 목록 안
  const named = ['수도권 1호선', '수도권 2호선', '수도권 3호선', '수도권 4호선', '수도권 5호선', '수도권 6호선', '수도권 7호선', '수도권 8호선', '수도권 9호선',
    '공항철도', '경의중앙선', '경춘선', '수인분당선', '신분당선', '우이신설선', '서해선', '경강선', '신림선', 'GTX-A'];
  for (const name of named) {
    const L = subwayLine({ name, subwayCityCode: 1000 });
    assert.ok(liveLine(L.subwayId), `${name} → ${L.subwayId} 가 허용 목록에 있어야`);
  }
  // 번호가 없는 노선 → 허용 목록 밖(서울시를 부르지 않음)
  for (const name of ['인천 1호선', '인천 2호선', '김포골드라인', '의정부경전철', '용인에버라인']) {
    const L = subwayLine({ name });
    assert.equal(L.subwayId, null, name);
    assert.deepEqual(liveSupport({ subwayId: L.subwayId }), { ok: false, reason: 'line' }, name);
  }
  assert.deepEqual(liveLine('1065'), { id: '1065', name: '공항철도', group: 'strict' });
  assert.deepEqual([liveLine('1061'), liveLine(''), liveLine(null), liveLine('toString'), liveLine('constructor')], [null, null, null, null, null], '목록에 없는 번호 · 객체 기본 이름은 아님');
});

test('비상 끄기 읽기(SEOUL_SUBWAY_OFF_LINES): 쉼표 · 공백 구분 · 허용 목록 안 번호만 · 오타 · 다른 값은 개수만', () => {
  const r = parseOffLines(' 1065, 1032;abc 1o65 ,, 9999 1065');
  assert.deepEqual([[...r.off], r.ignored], [['1065', '1032'], 3]);
  assert.deepEqual([[...parseOffLines('').off], parseOffLines('').ignored, parseOffLines(undefined).off.size], [[], 0, 0]);
  assert.deepEqual(liveSupport(AREX, r.off), { ok: false, reason: 'off', line: { id: '1065', name: '공항철도', group: 'strict' } });
  assert.deepEqual(liveSupport(LINE1, r.off), { ok: true, line: { id: '1001', name: '1호선', group: 'metro' } });
  assert.deepEqual(liveSupport(AREX), { ok: true, line: { id: '1065', name: '공항철도', group: 'strict' } }, '끈 노선이 없으면 그대로');
  assert.deepEqual(liveSupport(AREX, ['1065']), { ok: true, line: { id: '1065', name: '공항철도', group: 'strict' } }, 'Set이 아니면 무시(끄기 없음)');
});

test('열차 종류 읽기: type은 원문 그대로(최대 12자) · express는 예전 그대로(급행 · 특급)', () => {
  const p = (b) => parseSubwayRow(raw({ btrainSttus: b }), AT);
  assert.deepEqual(['일반', '급행', '특급', '직통', 'ITX', null, '  일반 '].map((b) => [p(b).type, p(b).express]),
    [['일반', false], ['급행', true], ['특급', true], ['직통', false], ['ITX', false], ['', false], ['일반', false]]);
  assert.equal(p('아주아주아주긴열차종류이름입니다').type.length, 12);
});

test('미리보기 ②: 공항철도 서울역 → 홍대입구 — 3분 뒤 직통(홍대입구에 안 섬)은 빼고 9분 뒤 일반 열차로', () => {
  const rows = rowsOf([
    raw({ btrainSttus: '직통', barvlDt: '180', arvlMsg2: '3분 후 (공덕)' }),
    raw({ btrainSttus: '일반', barvlDt: '540', arvlMsg2: '9분 후 (공덕)' }),
    raw({ updnLine: '상행', trainLineNm: '서울역행 - 종착방면', bstatnNm: '서울역', barvlDt: '60' }), // 반대 방향(세지 않음)
    raw({ subwayId: '1004', trainLineNm: '진접행 - 회현방면', bstatnNm: '진접', barvlDt: '30' }),       // 다른 노선(세지 않음)
  ]);
  const drops = {};
  assert.deepEqual(etas(rows, AREX, drops), [540]);
  assert.deepEqual(drops, { type: 1 }, '뺀 이유는 열차 종류 1건만(다른 노선 · 반대 방향은 원래 빠지는 열차라 세지 않음)');
});

test('strict(경의중앙 · 공항철도 · 경춘 · 수인분당): 일반만 — 빈 칸 · 처음 보는 값 · ITX · 급행은 뺌, 급행 경로면 급행도 씀', () => {
  const kinds = ['일반', '', '급행', '특급', '직통', 'ITX', '일반열차'];
  const rows = rowsOf(kinds.map((b, i) => raw({ btrainSttus: b, barvlDt: String(100 + i * 60) })));
  const drops = {};
  assert.deepEqual(etas(rows, AREX, drops), [100], "공항철도: '일반'이라고 적힌 열차만");
  assert.deepEqual(drops, { type: 6 });
  const jungang = { ...AREX, subwayId: '1063', lineName: '경의중앙선(급행)', line: '경의중앙선' };
  const jrows = rowsOf(kinds.map((b, i) => raw({ subwayId: '1063', btrainSttus: b, barvlDt: String(100 + i * 60) })));
  assert.deepEqual(etas(jrows, jungang), [100, 220], '급행 경로: 일반 · 급행만(특급 · 직통 · ITX · 빈 칸 · 처음 보는 값은 뺌)');
});

test('plain(신분당 · 우이신설 · 서해 · 경강 · 신림 · GTX-A): 빈 칸 · 일반만', () => {
  const rows = rowsOf(['', '일반', '급행', '직통', 'ITX', '특급'].map((b, i) => raw({
    subwayId: '1092', btrainSttus: b, trainLineNm: '북한산우이행 - 정릉방면', bstatnNm: '북한산우이', barvlDt: String(100 + i * 60) })));
  const drops = {};
  assert.deepEqual(etas(rows, UI, drops), [100, 160]);
  assert.deepEqual(drops, { type: 4 });
});

test('1~9호선(metro): 예전 규칙 그대로(빈 칸 = 일반, 일반 경로면 급행 · 특급 뺌) + 직통 · ITX만 더 뺌 · 급행 경로에선 특급만 더 뺌', () => {
  const kinds = ['일반', '', '급행', '특급', '직통', 'ITX', '보통'];
  const rows = rowsOf(kinds.map((b, i) => raw({ subwayId: '1001', btrainSttus: b, trainLineNm: '신창행 - 남영방면', bstatnNm: '신창', barvlDt: String(100 + i * 60) })));
  assert.deepEqual(etas(rows, LINE1), [100, 160, 460], "일반 경로: 일반 · 빈 칸 · 처음 보는 값('보통')은 예전처럼 씀");
  assert.deepEqual(etas(rows, { ...LINE1, lineName: '수도권 1호선(급행)' }), [100, 160, 220, 460], '급행 경로: 특급 · 직통 · ITX만 뺌');
  // 예전 동작(4호선): 다음 역을 모르면 상행/하행으로 대신 · 2호선은 안 씀 — transitPlan.test.js와 같은 결과
  const l4 = { kind: 'subway', subwayId: '1004', lineName: '수도권 4호선', next: '', stations: [], wayCode: 1 };
  const r4 = rowsOf([raw({ subwayId: '1004', updnLine: '상행', trainLineNm: '진접행 - 동대문방면', bstatnNm: '진접', barvlDt: '120' }), raw({ subwayId: '1004', updnLine: '하행', trainLineNm: '오이도행 - 충무로방면', bstatnNm: '오이도', barvlDt: '60' })]);
  assert.deepEqual(etas(r4, l4), [120]);
  assert.deepEqual(etas(r4.map((r) => ({ ...r, subwayId: '1002' })), { ...l4, subwayId: '1002' }), []);
});

test('노선 번호 · 방향: 번호가 빈 줄은 뺌(세기) · 광역 · 민자 노선은 다음 역 이름으로만(상행/하행으로 대신하지 않음) · 방면 형식이 아닌 줄은 뺌(세기)', () => {
  const rows = rowsOf([raw({ subwayId: '', barvlDt: '60' }), raw({ barvlDt: '120' }), raw({ trainLineNm: '인천공항2터미널행', barvlDt: '90' })]);
  const drops = {};
  assert.deepEqual(etas(rows, AREX, drops), [120]);
  assert.deepEqual(drops, { line: 1, dir: 1 });
  const noNext = {};
  assert.deepEqual(etas(rows, { ...AREX, next: '', wayCode: 2 }, noNext), [], '다음 역을 모르면 공항철도는 쓰지 않음(상행/하행 번호로 대신하지 않음)');
  assert.deepEqual(noNext, { line: 1, dir: 2 });
});

test('하차역 전에 끝나는 열차는 뺌(dest로 셈) · 막차 표시 · drops를 안 넘기면 예전처럼 목록만', () => {
  const rows = rowsOf([raw({ trainLineNm: '공덕행 - 공덕방면', bstatnNm: '공덕', barvlDt: '60' }), raw({ barvlDt: '200', lstcarAt: '1' })]);
  const drops = {};
  const got = trainsForLeg(rows, AREX, drops);
  assert.deepEqual([got.map((t) => [t.etaSec, t.last]), drops], [[[200, true]], { dest: 1 }]);
  assert.deepEqual(trainsForLeg(rows, AREX).map((t) => t.etaSec), [200]);
});

test('허용 목록 밖 구간(번호 없음)에 직접 써도 예전처럼 다음 역 이름으로만 고름 — 실제 서버 · 미리보기는 부르기 전에 막음', () => {
  const incheon1 = { kind: 'subway', subwayId: null, lineName: '인천 1호선', next: '귤현', stations: ['계양', '귤현', '박촌'] };
  const rows = rowsOf([raw({ subwayId: '1065', trainLineNm: '서울역행 - 김포공항방면', bstatnNm: '서울역', barvlDt: '90' })]);
  assert.deepEqual(etas(rows, incheon1), [], '다른 노선 열차의 다음 역(김포공항)이 귤현이 아니라 안 씀');
  assert.deepEqual(liveSupport(incheon1), { ok: false, reason: 'line' });
});
