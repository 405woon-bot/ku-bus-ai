// v2.3.0 점검: 실시간 허용 목록(19개 노선) 밖 · 비상 끄기 노선은 서울시를 부르지 않음(처음부터 '실시간 없음') · 공항철도 직통 제외 ·
//   /api/subway/test(고정 역 8곳 요약 · 10분 보관 · 하루 3번 · 심야 · 키 오류 · 상한) · /api/health 새 항목 · 서버 출발 알림도 같은 규칙.
//   가짜 서울시 지하철만 씁니다(실제 호출 없음). 열차는 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TEST_STATIONS, createSubwayService, summarizeTest } from '../src/transit/seoulSubway.js';
import { transitLive } from '../src/transit/transitLive.js';
import { createKv } from '../src/transit/kv.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createMockProvider } from '../src/transit/index.js';
import { planFor } from '../src/planner.js';
import { fakeSubwayFetch, SUBWAY_TEST_KEY } from './fixtures/subwayFixture.js';
import { SAMPLE_ODSAY_RESPONSE } from '../../shared/samples/odsaySample.js';
import { parseOdsayResult } from '../../shared/transitPlan.js';

const quiet = { warn() {}, info() {}, error() {} };
const kst = (s) => new Date(`${s}+09:00`);
const MIN = 60_000;
const CLASS = { id: 'c1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' };
const BASE_ROUTE = parseOdsayResult(SAMPLE_ODSAY_RESPONSE).paths[0]; // 2호선 → 4호선 → 버스(예시)
const FIRST = BASE_ROUTE.legs.findIndex((l) => l.kind !== 'walk');
/** 예시 경로의 첫 지하철만 바꾼 경로 */
const routeWithFirst = (patch) => ({ ...BASE_ROUTE, legs: BASE_ROUTE.legs.map((l, i) => (i === FIRST ? { ...l, ...patch, from: { ...l.from, ...(patch.from || {}) } } : l)) });
const INCHEON1 = routeWithFirst({ subwayId: null, line: '인천1호선', lineName: '인천 1호선', from: { name: '작전' } });
const AREX = routeWithFirst({ subwayId: '1065', line: '공항철도', lineName: '공항철도', next: '공덕', stations: ['서울역', '공덕', '홍대입구'], from: { name: '서울역' } });

/** 서울시 응답 한 줄(원문 형식 · 예시) */
const recptn = (ms) => { const d = new Date(ms + 9 * 3600_000); const two = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
const row = (ms, o = {}) => ({ subwayId: '1001', updnLine: '상행', trainLineNm: '종점행 - 다음역방면', statnNm: '역', btrainSttus: '일반', barvlDt: '120',
  bstatnNm: '종점', recptnDt: recptn(ms), arvlMsg2: '2분 후 (다음역)', arvlCd: '99', lstcarAt: '0', ...o });
const okJson = (rows) => ({ errorMessage: { status: 200, code: 'INFO-000', message: '정상 처리되었습니다.', total: rows.length }, realtimeArrivalList: rows });
/** 시험 역마다 예시 응답(성신여대입구는 없음 → 서울시 '해당하는 데이터가 없습니다') */
const scene = (ms) => ({
  서울: [row(ms), row(ms, { btrainSttus: '급행' }), row(ms, { subwayId: '1065' }), row(ms, { subwayId: '1065', btrainSttus: '직통', barvlDt: '0' }), row(ms, { subwayId: '1063' }), row(ms, { subwayId: '1032', btrainSttus: '' })],
  왕십리: [row(ms, { subwayId: '1075' }), row(ms, { subwayId: '1075', btrainSttus: '급행' }), row(ms, { subwayId: '1063' })],
  상봉: [row(ms, { subwayId: '1067', btrainSttus: 'ITX' }), row(ms, { subwayId: '1007' })],
  강남: [row(ms, { subwayId: '1077', btrainSttus: '' }), row(ms, { subwayId: '1002' })],
  김포공항: [row(ms, { subwayId: '1093' }), row(ms, { subwayId: '1061' }), row(ms, { subwayId: '1065' })],
  신림: [row(ms, { subwayId: '1094', trainLineNm: '샛강행' })],
  수서: [row(ms, { subwayId: '1032' }), row(ms, { subwayId: '1003' })],
});
const sceneFetch = (clock) => fakeSubwayFetch({ clock, respond: (parts) => { const rows = scene(clock())[parts[8]]; return rows ? okJson(rows) : null; } });
const service = ({ env = {}, at = kst('2026-11-24T13:00:00').getTime(), fetchImpl, kv = null } = {}) => {
  const clock = { t: at };
  const f = fetchImpl || sceneFetch(() => clock.t);
  const svc = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY, ...env }, fetchImpl: f, clock: () => clock.t, log: quiet, kv });
  return { svc, f, clock };
};
const noKey = (x) => !JSON.stringify(x).includes(SUBWAY_TEST_KEY);

test('번호 없는 노선(인천1호선)으로 시작: 서울시를 부르지 않고 처음부터 실시간 없음(출발 한참 전 · force여도) · 오늘 부르지 않은 횟수', async () => {
  const { svc, f } = service();
  for (const force of [false, true]) {
    const out = await transitLive({ route: INCHEON1, provider: createMockProvider('jeongneung'), subway: svc, nowDate: kst('2026-11-16T06:00:00'), cls: CLASS, force });
    assert.deepEqual([out.first.source, out.first.reason, out.first.kind, out.first.trains], ['nodata', 'line', 'subway', []]);
  }
  assert.equal(f.calls.length, 0, '서울시 호출 없음');
  assert.deepEqual(svc.health().skipped, { line: 2, off: 0 });
  // 같은 시각, 허용 목록 노선(2호선)은 예전처럼 '출발 30분 전부터'(skip)
  const std = await transitLive({ route: BASE_ROUTE, provider: createMockProvider('jeongneung'), subway: svc, nowDate: kst('2026-11-16T06:00:00'), cls: CLASS });
  assert.deepEqual([std.first.source, std.first.reason], ['skip', 'not-yet']);
});

test('비상 끄기(SEOUL_SUBWAY_OFF_LINES): 끈 노선만 부르지 않음 · 목록 밖 번호 · 오타는 개수만(값은 싣지 않음) · 지우면 원래대로', async () => {
  const off = service({ env: { SEOUL_SUBWAY_OFF_LINES: '1002, abc,1o65 , 1032' } });
  const out = await transitLive({ route: BASE_ROUTE, provider: createMockProvider('jeongneung'), subway: off.svc, nowDate: kst('2026-11-16T08:00:00'), cls: CLASS, force: true });
  assert.deepEqual([out.first.source, out.first.reason, off.f.calls.length], ['nodata', 'off', 0]);
  const h = off.svc.health();
  assert.deepEqual([h.lines, h.skipped], [{ total: 19, on: 17, off: ['1002', '1032'], offIgnored: 2 }, { line: 0, off: 1 }]);
  assert.ok(!JSON.stringify(h).includes('abc') && !JSON.stringify(h).includes('1o65'), '적힌 글자는 그대로 내보내지 않음');
  // 비우면 19개 모두 켬 — 2호선은 실시간(홍대입구 예시 열차)
  const on = service({ fetchImpl: fakeSubwayFetch({ clock: () => kst('2026-11-16T08:00:00').getTime() }), at: kst('2026-11-16T08:00:00').getTime() });
  const live = await transitLive({ route: BASE_ROUTE, provider: createMockProvider('jeongneung'), subway: on.svc, nowDate: kst('2026-11-16T08:00:00'), cls: CLASS, force: true });
  assert.deepEqual([live.first.source, live.first.trains.map((t) => t.etaSec), on.svc.health().lines], ['seoul', [150, 420], { total: 19, on: 19, off: [] }]);
  const ex = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(ex, /^SEOUL_SUBWAY_OFF_LINES=$/m, '.env.example은 값 비움');
});

test('공항철도 서울역 → 홍대입구: 3분 뒤 직통은 빼고 9분 뒤 일반 열차로 계산 · 오늘 열차 종류로 뺀 횟수(노선 · 역 이름 없이)', async () => {
  const at = kst('2026-11-24T08:00:00').getTime();
  const f = fakeSubwayFetch({ clock: () => at, respond: (parts) => (parts[8] === '서울' ? okJson([
    row(at, { subwayId: '1065', updnLine: '하행', trainLineNm: '인천공항2터미널행 - 공덕방면', bstatnNm: '인천공항2터미널', btrainSttus: '직통', barvlDt: '180' }),
    row(at, { subwayId: '1065', updnLine: '하행', trainLineNm: '인천공항2터미널행 - 공덕방면', bstatnNm: '인천공항2터미널', btrainSttus: '일반', barvlDt: '540' }),
    row(at, { subwayId: '1001', trainLineNm: '연천행 - 시청방면', bstatnNm: '연천', barvlDt: '60' }),
  ]) : null) });
  const { svc } = service({ fetchImpl: f, at });
  const out = await transitLive({ route: AREX, provider: createMockProvider('jeongneung'), subway: svc, nowDate: new Date(at), force: true });
  assert.deepEqual([out.first.source, out.first.station, out.first.trains.map((t) => t.etaSec)], ['seoul', '서울', [540]]);
  const h = svc.health();
  assert.deepEqual(h.filtered, { line: 0, dir: 0, type: 1, dest: 0 });
  assert.ok(!JSON.stringify(h).includes('서울') && !JSON.stringify(h).includes('1065'), 'health에는 역 · 노선 이름 없이 합계만');
  // 일반 열차가 없으면 실시간 없음(배차로 예상)
  const f2 = fakeSubwayFetch({ clock: () => at, respond: (parts) => (parts[8] === '서울' ? okJson([row(at, { subwayId: '1065', trainLineNm: '인천공항2터미널행 - 공덕방면', btrainSttus: '직통' })]) : null) });
  const none = await transitLive({ route: AREX, provider: createMockProvider('jeongneung'), subway: service({ fetchImpl: f2, at }).svc, nowDate: new Date(at), force: true });
  assert.deepEqual([none.first.source, none.first.reason, none.first.trains], ['nodata', 'no-train', []]);
});

test('서버 출발 알림(planFor)도 같은 규칙: 번호 없는 노선으로 시작하면 서울시를 부르지 않음', async () => {
  const { svc, f } = service({ at: kst('2026-11-16T08:00:00').getTime() });
  const user = { classes: [CLASS], stop: null, prefs: { walkToStopMin: 5, marginMin: 5, notify: true, notifyBeforeMin: 10 }, walkOverrides: {}, fired: {}, personal: { offsetMin: 0 }, arrivals: [], transit: { mode: 'transit', route: INCHEON1 } };
  const r = await planFor(user, createMockProvider('jeongneung'), kst('2026-11-16T08:00:00'), { windowMin: 180, subway: svc });
  assert.deepEqual([r.mode, r.live.first.source, r.live.first.reason, f.calls.length], ['transit', 'nodata', 'line', 0]);
  assert.notEqual(r.rec.pick.legs.find((l) => l.kind === 'subway').src, 'live', '첫 지하철은 배차로 예상');
});

test('/api/subway/test 요약: 고정 역 8곳 · 노선 번호별 열차 종류 · 방면 형식 · 판정 · 목록에 없는 번호 · 키는 안 나옴', async () => {
  const { svc, f } = service();
  const r = await svc.test();
  assert.equal(r.ok, true);
  assert.deepEqual(r.stations.map((s) => [s.station, s.status]), TEST_STATIONS.map((s) => [s, s === '성신여대입구' ? 'nodata' : 'ok']));
  assert.deepEqual(TEST_STATIONS, ['서울', '왕십리', '상봉', '강남', '성신여대입구', '김포공항', '신림', '수서']);
  assert.equal(f.calls.length, 8, '한 번에 8건');
  assert.deepEqual(r.lines['1065'].types, { 일반: 2, 직통: 1 });
  assert.deepEqual([r.lines['1065'].etaZero, r.lines['1065'].stations, r.lines['1065'].name], [1, ['서울', '김포공항'], '공항철도']);
  assert.deepEqual(Object.fromEntries(Object.entries(r.check).map(([id, c]) => [id, c.result.split('(')[0].split(':')[0]])), {
    1032: '보임', 1063: '보임', 1065: '보임', 1067: '확인 필요', 1075: '보임', 1077: '보임', 1081: '시험 역 없음', 1092: '안 보임', 1093: '보임', 1094: '확인 필요' });
  assert.match(r.check['1067'].result, /'일반' 표시가 없어요/);
  assert.match(r.check['1094'].result, /방면' 형식이 아닌 줄/);
  assert.deepEqual(r.unknownIds, ['1061']);
  assert.equal(r.lines['1061'].name, '목록에 없는 번호');
  assert.ok(!('1092' in r.lines) && r.lines['1001'].rows === 2, '1~9호선은 판정 없이 lines에만');
  assert.deepEqual([r.runsToday, r.maxPerDay, r.cached, r.lines['1065'].sample.btrainSttus], [1, 3, false, '일반']);
  assert.deepEqual(r.allow, { total: 19, on: 19, off: [] }, 'allow = 허용 목록(켠 개수 · 끈 번호)');
  assert.ok(noKey(r) && noKey(svc.health()));
  assert.equal(svc.health().callsToday, 8, '하루 상한(900) 안에서 셈');
});

test('/api/subway/test 보관 · 하루 3번(외부 DB 카운터) · 심야 · 키 없음은 부르지 않음(횟수도 안 씀)', async () => {
  const kv = createKv();
  const { svc, f, clock } = service({ kv });
  await svc.test();
  assert.deepEqual([(await svc.test()).cached, f.calls.length], [true, 8], '10분 안에는 보관한 결과');
  clock.t += 11 * MIN; await svc.test();
  clock.t += 11 * MIN; await svc.test();
  assert.equal(f.calls.length, 24);
  clock.t += 11 * MIN;
  const over = await svc.test();
  assert.deepEqual([over.ok, over.reason, over.runsToday, f.calls.length], [false, 'test-limit', 3, 24], '네 번째는 부르지 않음');
  assert.deepEqual(svc.health().test.runsToday, 3);
  assert.equal(await kv.getNum('kubusai:subway:test:2026-11-24'), 3, '재시작해도 하루 3번(외부 DB 카운터)');
  const again = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, kv, fetchImpl: f, clock: () => clock.t, log: quiet });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await again.test()).reason, 'test-limit');
  clock.t = kst('2026-11-25T13:00:00').getTime(); // 다음 날(서울 자정 지남)
  assert.deepEqual([(await svc.test()).ok, svc.health().test.runsToday], [true, 1]);
  const night = service({ at: kst('2026-11-24T02:00:00').getTime() });
  const n = await night.svc.test();
  assert.deepEqual([n.ok, n.reason, night.f.calls.length, night.svc.health().test.runsToday], [false, 'night', 0, 0]);
  const dawn = service({ at: kst('2026-11-24T05:31:00').getTime() });
  assert.equal((await dawn.svc.test()).ok, true, '05:30부터는 시험');
  const nokey = createSubwayService({ env: {}, fetchImpl: f, log: quiet });
  assert.deepEqual([(await nokey.test()).reason, nokey.health().test.runsToday], ['no-key', 0]);
});

test('/api/subway/test: 첫 역에서 키 오류면 나머지 역은 부르지 않음 · 하루 상한에 닿으면 그 역부터 cap', async () => {
  const bad = createSubwayService({ env: { SEOUL_SUBWAY_KEY: 'WRONG-KEY' }, fetchImpl: fakeSubwayFetch(), clock: () => kst('2026-11-24T13:00:00').getTime(), log: quiet });
  const r = await bad.test();
  assert.deepEqual([r.ok, r.reason, r.stations.map((s) => s.status)], [false, 'auth', ['auth', ...Array(7).fill('skipped')]]);
  assert.match(r.message, /첫 역\(서울\)/);
  assert.ok(!JSON.stringify(r).includes('WRONG-KEY') && !JSON.stringify(bad.health()).includes('WRONG-KEY'));
  assert.equal((await bad.test()).cached, true, '키 오류 결과도 10분 보관(연타 방지)');
  const empty = service({ fetchImpl: fakeSubwayFetch() }); // 시험 역에 열차 정보가 하나도 없음
  const e = await empty.svc.test();
  assert.deepEqual([e.ok, e.reason, e.stations.every((s) => s.status === 'nodata'), empty.f.calls.length], [false, 'nodata', true, 8]);
  assert.match(e.message, /시험 역 모두 열차 정보가 없어요/);
  const capped = service({ env: { SEOUL_SUBWAY_DAILY_CAP: '3' } });
  const c = await capped.svc.test();
  assert.deepEqual([c.ok, c.stations.map((s) => s.status), capped.f.calls.length], [true, ['ok', 'ok', 'ok', 'cap', 'cap', 'cap', 'cap', 'cap'], 3]);
});

test('API: GET /api/subway/test 연결 · /api/health seoulSubway 새 항목(lines · filtered · skipped · test) · 서비스 없으면 no-service', async () => {
  const { svc } = service();
  const at = kst('2026-11-24T13:00:00');
  const run = async (subway, fn) => {
    const app = createApp({ store: createStore(null), provider: createMockProvider('jeongneung'), pusher: { enabled: false, publicKey: null }, now: () => at, subway });
    const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
    try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
  };
  await run(svc, async (base) => {
    const t = await (await fetch(`${base}/api/subway/test`)).json();
    assert.deepEqual([t.ok, t.stations.length, t.check['1065'].result], [true, 8, '보임']);
    const h = (await (await fetch(`${base}/api/health`)).json()).seoulSubway;
    assert.deepEqual([h.keyConfigured, h.callsToday, h.lines, h.filtered, h.skipped, h.test.runsToday, h.test.maxPerDay],
      [true, 8, { total: 19, on: 19, off: [] }, { line: 0, dir: 0, type: 0, dest: 0 }, { line: 0, off: 0 }, 1, 3]);
    assert.ok(noKey(t) && noKey(h));
  });
  await run(null, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/subway/test`)).json(), { ok: false, reason: 'no-service' });
  });
});

test('summarizeTest: 줄 수가 20이면 full(잘렸을 수 있음) · 번호 없는 줄 · 긴 값은 잘라서', () => {
  const ms = kst('2026-11-24T13:00:00').getTime();
  const s = summarizeTest([{ station: '서울', status: 'ok', asked: 20, rows: [...Array(19).fill(row(ms)), row(ms, { subwayId: '', trainLineNm: 'x'.repeat(200) })] }], ms);
  assert.deepEqual([s.stations[0].full, s.stations[0].asked, s.lines['(빈 번호)'].rows, s.lines['(빈 번호)'].sample.trainLineNm.length, s.unknownIds], [true, 20, 1, 40, ['(빈 번호)']]);
  const s40 = summarizeTest([{ station: '서울', status: 'ok', asked: 40, rows: Array(20).fill(row(ms)) }], ms);
  assert.equal(s40.stations[0].full, undefined, 'v2.4.1: 40줄을 물었는데 20줄이면 잘린 것이 아님');
  // 바깥 값이 객체 기본 이름이어도 섞이지 않음(번호는 숫자만, 열차 종류는 그대로 한 칸)
  const odd = summarizeTest([{ station: '서울', status: 'ok', rows: [row(ms, { subwayId: '__proto__', btrainSttus: '__proto__' }), row(ms, { btrainSttus: 'constructor' })] }]);
  assert.deepEqual(Object.keys(odd.lines).sort(), ['(형식이 다른 번호)', '1001']);
  assert.deepEqual([Object.keys(odd.lines['(형식이 다른 번호)'].types), odd.lines['1001'].types.constructor], [['__proto__'], 1]);
  assert.equal(({}).rows, undefined, '객체 기본 모양이 바뀌지 않음');
});
