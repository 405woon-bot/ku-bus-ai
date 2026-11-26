// v2.5.2 점검: 실시간 지하철에서 종착이 역 이름이 아닌 줄('-2행 - 일원방면')은 정해진 규칙으로 빼고 /api/health filtered.dest로 셈 ·
//   서버 출발 알림(planFor)도 같은 규칙 · 확인 도구(/api/subway/test) 노선별 oddDest 개수와 예 한 줄 · 방면 형식은 실제 계산과 같은 규칙으로 셈.
//   가짜 서울시 지하철만 씁니다(실제 호출 없음). 열차는 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubwayService, summarizeTest } from '../src/transit/seoulSubway.js';
import { transitLive } from '../src/transit/transitLive.js';
import { createMockProvider } from '../src/transit/index.js';
import { planFor } from '../src/planner.js';
import { fakeSubwayFetch, SUBWAY_TEST_KEY } from './fixtures/subwayFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult } from '../../shared/transitPlan.js';

const quiet = { warn() {}, info() {}, error() {} };
const kst = (s) => new Date(`${s}+09:00`).getTime();
const BASE_ROUTE = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0]; // 2호선 → 4호선 → 버스(예시)
const FIRST = BASE_ROUTE.legs.findIndex((l) => l.kind !== 'walk');
// 예시 경로의 첫 지하철을 3호선 수서 → 일원 방면으로(예시)
const LINE3 = { ...BASE_ROUTE, legs: BASE_ROUTE.legs.map((l, i) => (i === FIRST ? { ...l, subwayId: '1003', line: '3호선', lineName: '수도권 3호선', next: '일원', stations: ['수서', '일원', '대청', '학여울', '대치', '도곡'], from: { ...l.from, name: '수서' } } : l)) };
const recptn = (ms) => { const d = new Date(ms + 9 * 3600_000); const two = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
const row = (ms, o = {}) => ({ subwayId: '1003', updnLine: '상행', trainLineNm: '대화행 - 일원방면', statnNm: '수서', btrainSttus: '일반', barvlDt: '540', bstatnNm: '대화',
  recptnDt: recptn(ms), arvlMsg2: '9분 후 (오금)', arvlCd: '99', lstcarAt: '0', ...o });
const okJson = (rows) => ({ errorMessage: { status: 200, code: 'INFO-000', message: '정상 처리되었습니다.', total: rows.length }, realtimeArrivalList: rows });
const SUSEO = (ms) => [row(ms, { trainLineNm: '-2행 - 일원방면', bstatnNm: '-2', barvlDt: '330', arvlMsg2: '5분 30초 후 (오금)' }), row(ms), row(ms, { trainLineNm: '-2행 - 오금방면', bstatnNm: '-2', updnLine: '하행', barvlDt: '200' })];
const service = (at) => {
  const f = fakeSubwayFetch({ clock: () => at, respond: (parts) => (parts[8] === '수서' ? okJson(SUSEO(at)) : null) });
  return createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: f, clock: () => at, log: quiet });
};

test("첫 지하철: 종착 '-2'(역 이름이 아님) 열차는 빼고 다음 열차로 · /api/health filtered.dest 1(반대 방향은 세지 않음) · 역 · 노선 이름 없이", async () => {
  const at = kst('2026-11-26T00:08:00');
  const svc = service(at);
  const out = await transitLive({ route: LINE3, provider: createMockProvider('jeongneung'), subway: svc, nowDate: new Date(at), force: true });
  assert.deepEqual([out.first.source, out.first.station, out.first.trains.map((t) => [t.dest, t.etaSec])], ['seoul', '수서', [['대화', 540]]]);
  const h = svc.health();
  assert.deepEqual(h.filtered, { line: 0, dir: 0, type: 0, dest: 1 });
  const hd = JSON.stringify(h);
  assert.ok(!hd.includes('수서') && !hd.includes('일원') && !hd.includes('"-2"') && !hd.includes('1003'), `health에는 합계만: ${hd}`);
});

test("종착 '-2' 열차뿐이면 실시간 없음(배차로 예상) · 서버 출발 알림(planFor)도 같은 규칙", async () => {
  const at = kst('2026-11-26T00:08:00');
  const f = fakeSubwayFetch({ clock: () => at, respond: (parts) => (parts[8] === '수서' ? okJson([SUSEO(at)[0]]) : null) });
  const svc = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: f, clock: () => at, log: quiet });
  const none = await transitLive({ route: LINE3, provider: createMockProvider('jeongneung'), subway: svc, nowDate: new Date(at), force: true });
  assert.deepEqual([none.first.source, none.first.reason, none.first.trains], ['nodata', 'no-train', []]);
  // 서버 출발 알림: 출발 시각을 지금에 맞춘 수업(월요일 09:00 → 출발 08:xx)으로 같은 계산 — 첫 지하철은 표준 대기('std')
  const mon = kst('2026-11-16T07:40:00');
  const f2 = fakeSubwayFetch({ clock: () => mon, respond: (parts) => (parts[8] === '수서' ? okJson([SUSEO(mon)[0]]) : null) });
  const svc2 = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: f2, clock: () => mon, log: quiet });
  const user = { classes: [{ id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' }], stop: null,
    prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {}, personal: { offsetMin: 0 }, arrivals: [], transit: { mode: 'transit', route: LINE3 } };
  const r = await planFor(user, createMockProvider('jeongneung'), new Date(mon), { windowMin: 180, subway: svc2 });
  const s = r.rec.pick.legs.find((x) => x.i === FIRST);
  assert.deepEqual([r.live.first.source, r.live.first.reason, f2.calls.length], ['nodata', 'no-train', 1], '출발 시각(07:39) 근처라 서울시를 불렀고, 쓸 열차가 없음');
  assert.equal(s.src, 'std', "종착을 모르는 열차로 탑승 시각을 잡지 않음");
  assert.equal(svc2.health().filtered.dest, 1);
});

test("확인 도구: 노선별 oddDest(종착이 역 이름이 아닌 줄 개수)와 예 한 줄 · 없으면 0(예 없음) · 방면 형식은 실제 계산과 같은 규칙으로 셈", async () => {
  const at = kst('2026-11-26T00:08:00');
  const s = summarizeTest([
    { station: '수서', status: 'ok', rows: SUSEO(at), asked: 40 },
    { station: '왕십리', status: 'ok', rows: [row(at, { subwayId: '1002', trainLineNm: '신도림행 - 상왕십리방면', bstatnNm: '신도림' })], asked: 40 },
  ], at);
  assert.deepEqual([s.lines['1003'].oddDest, s.lines['1003'].oddDestSample, s.lines['1003'].dirFormat, s.lines['1003'].rows],
    [2, { station: '수서', trainLineNm: '-2행 - 일원방면', bstatnNm: '-2' }, 3, 3]);
  assert.deepEqual([s.lines['1002'].oddDest, 'oddDestSample' in s.lines['1002']], [0, false]);
  // 서비스 전체(8개 역)로도: 수서만 예시 줄 · 나머지 역은 서울시 '데이터 없음'
  const t = await service(at).test();
  assert.deepEqual([t.lines['1003'].oddDest, t.lines['1003'].oddDestSample.bstatnNm, t.stations.find((x) => x.station === '수서').rows], [2, '-2', 3]);
});
