// v2.4.1 점검: 서울시 실시간 지하철을 한 번에 40줄로(호출 수 그대로) · 서울시가 40줄 요청을 받지 않으면 그날은 20줄로 자동 되돌리고 한 번 더 ·
//   시간 초과 · 5xx는 줄 수를 바꾸지 않음 · /api/subway/test 역별 asked · 노선별 남은 시간 방법(eta) 개수 · health rows · rowsFallback.
//   가짜 서울시 지하철만 씁니다. 열차는 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubwayService } from '../src/transit/seoulSubway.js';
import { fakeSubwayFetch, SUBWAY_TEST_KEY } from './fixtures/subwayFixture.js';

const quiet = { warn() {}, info() {}, error() {} };
const kst = (s) => new Date(`${s}+09:00`).getTime();
const okText = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const two = (n) => String(n).padStart(2, '0');
const recptn = (ms) => { const d = new Date(ms + 9 * 3600_000); return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
const row = (ms, o = {}) => ({ subwayId: '1004', updnLine: '상행', trainLineNm: '진접행 - 동대문방면', statnNm: '역', btrainSttus: '일반', barvlDt: '120', bstatnNm: '진접',
  recptnDt: recptn(ms), arvlMsg2: '2분 후 (동대문)', arvlCd: '99', lstcarAt: '0', ...o });
const ERR_336 = { status: 500, code: 'ERROR-336', message: '데이터요청은 한번에 최대 1000건을 넘을 수 없습니다.', link: '', developerMessage: '', total: 0 };
const service = ({ env = {}, at = kst('2026-11-25T13:00:00'), respond, timeoutMs } = {}) => {
  const clock = { t: at };
  const f = fakeSubwayFetch({ clock: () => clock.t, respond });
  const svc = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY, ...env }, fetchImpl: f, clock: () => clock.t, log: quiet, ...(timeoutMs ? { timeoutMs } : {}) });
  return { svc, f, clock };
};
const rowsAsked = (c) => c.url.pathname.split('/')[7]; // /api/subway/{KEY}/json/realtimeStationArrival/0/{줄 수}/{역명}

test('한 번에 40줄(호출 수는 그대로 1건) · 21번째 줄 뒤 열차도 받음 · health rows 40 · rowsFallback 없음', async () => {
  const at = kst('2026-11-25T13:00:00');
  const { svc, f } = service({ respond: (parts) => (parts[8] === '서울' ? okText({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: Array.from({ length: 30 }, (_, i) => row(at, { barvlDt: String(60 + i * 10) })) }) : null) });
  const a = await svc.arrivals('서울역');
  assert.deepEqual([a.source, a.rows.length, f.calls.length, rowsAsked(f.calls[0])], ['seoul', 30, 1, '40']);
  assert.deepEqual([svc.health().rows, svc.health().rowsFallback, svc.health().callsToday], [40, null, 1]);
});

test('서울시가 40줄 요청을 받지 않으면(처음 보는 오류 코드) 그날은 20줄로 바꾸고 한 번 더 · 다음 역부터 바로 20줄 · 다음 날 다시 40줄', async () => {
  const at = kst('2026-11-25T13:00:00');
  const respond = (parts) => (parts[7] === '40' ? okText(ERR_336) : parts[8] === '서울' ? okText({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [row(at)] }) : null);
  const { svc, f, clock } = service({ respond });
  const a = await svc.arrivals('서울');
  assert.deepEqual([a.source, a.rows.length, f.calls.map(rowsAsked)], ['seoul', 1, ['40', '20']]);
  const h = svc.health();
  assert.deepEqual([h.rows, h.rowsFallback.reason, h.callsToday], [20, 'ERROR-336', 2], '되돌리기 위한 한 번도 호출 수에 셈');
  await svc.arrivals('홍대입구');
  assert.deepEqual(f.calls.map(rowsAsked), ['40', '20', '20'], '그날 다음 역은 바로 20줄');
  clock.t = kst('2026-11-26T13:00:00');
  assert.deepEqual([svc.health().rows, svc.health().rowsFallback], [40, null], '자정이 지나면 다시 40줄');
  const before = f.calls.length;
  await svc.arrivals('총신대입구(이수)');
  assert.deepEqual(f.calls.slice(before).map(rowsAsked), ['40', '20'], '다음 날도 40줄부터 묻고, 서울시가 또 거절하면 그날도 20줄');
  assert.equal(svc.health().rowsFallback.at, '2026-11-26T04:00:00.000Z');
});

test('HTTP 4xx도 20줄로 되돌림 · 5xx · 시간 초과는 잠깐의 문제일 수 있어 줄 수를 바꾸지 않음', async () => {
  const at = kst('2026-11-25T13:00:00');
  const bad = service({ respond: (parts) => (parts[7] === '40' ? { ok: false, status: 400, text: async () => 'Bad Request' } : okText({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [row(at)] })) });
  assert.equal((await bad.svc.arrivals('서울')).source, 'seoul');
  assert.deepEqual([bad.f.calls.map(rowsAsked), bad.svc.health().rowsFallback.reason], [['40', '20'], 'HTTP 400']);
  const down = service({ respond: () => ({ ok: false, status: 503, text: async () => 'Service Unavailable' }) });
  const d = await down.svc.arrivals('서울');
  assert.deepEqual([d.source, down.f.calls.map(rowsAsked), down.svc.health().rows, down.svc.health().rowsFallback], ['error', ['40'], 40, null]);
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = createSubwayService({ env: { SEOUL_SUBWAY_KEY: SUBWAY_TEST_KEY }, fetchImpl: hang, clock: () => at, log: quiet, timeoutMs: 30 });
  const s = await slow.arrivals('서울');
  assert.deepEqual([s.source, slow.health().rows, slow.health().rowsFallback], ['error', 40, null]);
  assert.match(s.message, /0\.03초 안에 답하지 않았어요/);
});

test('/api/subway/test: 역별 asked(물은 줄 수) · 40줄을 꽉 채워야 full · 노선별 eta(남은 시간을 구한 방법) 개수 · rowsAsked', async () => {
  const at = kst('2026-11-25T13:00:00');
  const ms = at;
  const SCENE = {
    서울: [row(ms, { subwayId: '1001', barvlDt: '90' }), row(ms, { subwayId: '1065', barvlDt: '0', arvlCd: '1', arvlMsg2: '서울 도착' }), row(ms, { subwayId: '1065', barvlDt: '0', arvlCd: '2', arvlMsg2: '서울 출발' }),
      row(ms, { subwayId: '1063', barvlDt: '0', arvlMsg2: '[2]번째 전역 (서강대)' }), row(ms, { subwayId: '1063', barvlDt: '0', arvlCd: '5', arvlMsg2: '전역 도착' }), row(ms, { subwayId: '1063', barvlDt: '0', arvlMsg2: '운행중' })],
    왕십리: Array.from({ length: 40 }, () => row(ms, { subwayId: '1075', barvlDt: '0', arvlMsg2: '3분 후 (청량리)' })),
  };
  const { svc } = service({ respond: (parts) => (SCENE[parts[8]] ? okText({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: SCENE[parts[8]] }) : null) });
  const r = await svc.test();
  assert.deepEqual([r.ok, r.rowsAsked, r.stations[0].asked, r.stations[0].full, r.stations[1].asked, r.stations[1].full], [true, 40, 40, undefined, 40, true]);
  assert.deepEqual(r.lines['1001'].eta, { seconds: 1 });
  assert.deepEqual(r.lines['1065'].eta, { arrive: 1, departed: 1 });
  assert.deepEqual(r.lines['1063'].eta, { stationsAway: 1, code: 1, unknown: 1 });
  assert.deepEqual(r.lines['1075'].eta, { message: 40 });
});
