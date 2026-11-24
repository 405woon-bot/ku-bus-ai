// v2.2.6 점검: ① 심야에 근처 국민대행 정류장을 못 찾으면 night 표시 · 1분만 기억 / ③ 확인하는 정류장 6곳 · 3곳 찾으면 멈춤 /
//   ② AI 문장이 원인을 결과에 이어 단정하면 기본 안내(지시문 + 검사 이중 차단 · 같은 상황 5분 캐시 · 오늘 거른 수) / ⑤ Gemini 기본 4초.
//   가짜 서울시 · 가짜 Gemini만 씁니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService } from '../src/transit/index.js';
import { createAccidentService } from '../src/transit/seoulAccident.js';
import { createWeatherService } from '../src/transit/kmaWeather.js';
import { createNearKuFinder } from '../src/transit/nearKu.js';
import { EXAMPLE_FACTS, SYSTEM_PROMPT, createExplainService } from '../src/transit/geminiExplain.js';
import { cleanAiText, ruleText } from '../../shared/explain.js';
import { fakeSeoulFetch } from './fixtures/seoulFixture.js';
import { fakeAccidentFetch } from './fixtures/accidentFixture.js';
import { fakeKmaFetch } from './fixtures/kmaFixture.js';
import { causalSentenceFor, fakeGeminiFetch } from './fixtures/geminiFixture.js';

const DAY_1300 = new Date('2026-11-24T04:00:00Z').getTime();   // 서울 화 13:00
const NIGHT_2340 = new Date('2026-11-24T14:40:00Z').getTime(); // 서울 화 23:40
const MIN = 60_000;
const quiet = { warn() {}, info() {}, error() {} };
const STOPS = Array.from({ length: 8 }, (_, i) => ({ arsId: String(10001 + i), name: `정류장${i + 1}`, lat: 37.6 + i * 0.0003, lon: 127.0, distM: 50 * (i + 1) }));

/** 가짜 서울시: 근처 정류장 8곳(가까운 순) · 정류장마다 국민대행 여부 / 실패 / 한도 */
function stub({ stops = STOPS, ku = [], fail = [], quota = null } = {}) {
  const calls = [];
  return {
    calls,
    nearStops: async () => stops,
    stopTrips: async (arsId) => {
      calls.push(arsId);
      if (arsId === quota) return { source: 'mock', reason: 'quota', trips: [] };
      if (fail.includes(arsId)) throw Object.assign(new Error('시간 초과'), { kind: 'timeout' });
      return { source: 'seoul', trips: ku.includes(arsId) ? [{ no: '171' }] : [] };
    },
  };
}

test('③ 후보 정류장: 기본 6곳(가까운 순) · 국민대행 3곳을 찾으면 더 부르지 않음 · 화면은 3곳 · 예전 값(4)도 그대로 쓸 수 있음', async () => {
  const p = stub({ ku: ['10002', '10004', '10005', '10006'] });
  const f = createNearKuFinder({ provider: p, clock: () => DAY_1300 });
  const r = await f.find(37.6, 127.0);
  assert.deepEqual([r.ok, r.stops.map((s) => s.arsId), p.calls], [true, ['10002', '10004', '10005'], ['10001', '10002', '10003', '10004', '10005']]);
  assert.equal(r.night, undefined);
  assert.deepEqual([f.health().maxStops, f.health().show], [6, 3]);
  // 6곳 안에 없으면 7번째는 부르지 않음(빈 결과 · 낮이라 night 없음)
  const far = stub({ ku: ['10007'] });
  const r2 = await createNearKuFinder({ provider: far, clock: () => DAY_1300 }).find(37.6, 127.0);
  assert.deepEqual([r2.ok, r2.stops, r2.night, far.calls.length], [true, [], undefined, 6]);
  // 예전처럼 4곳이면 4번째까지만(설정 값은 그대로 받음)
  const four = stub({ ku: ['10006'] });
  const r3 = await createNearKuFinder({ provider: four, clock: () => DAY_1300, maxStops: 4 }).find(37.6, 127.0);
  assert.deepEqual([r3.stops.length, four.calls.length], [0, 4]);
});

test('① 심야(서울 23:00 ~ 04:30 전): 정류장을 확인했는데 국민대행이 없으면 night 표시 · 1분만 기억(아침에 다시 확인) / 낮은 지금처럼 6시간', async () => {
  const clock = { t: NIGHT_2340 };
  const p = stub();
  const f = createNearKuFinder({ provider: p, clock: () => clock.t });
  const r = await f.find(37.6, 127.0);
  assert.deepEqual(r, { ok: true, stops: [], radiusM: 400, night: true });
  assert.equal(p.calls.length, 6);
  clock.t += 30_000;
  await f.find(37.6, 127.0);
  assert.equal(p.calls.length, 6, '30초 안이면 기억한 결과');
  clock.t += 31_000;
  await f.find(37.6, 127.0);
  assert.equal(p.calls.length, 12, '1분이 지나면 다시 확인(6시간 기억하지 않음)');
  assert.equal(f.health().night, 2);
  // 낮: 같은 빈 결과는 night 없이 6시간 기억(지금 그대로)
  const dclock = { t: DAY_1300 };
  const d = stub();
  const df = createNearKuFinder({ provider: d, clock: () => dclock.t });
  assert.deepEqual(await df.find(37.6, 127.0), { ok: true, stops: [], radiusM: 400 });
  dclock.t += 61_000;
  await df.find(37.6, 127.0);
  assert.equal(d.calls.length, 6, '낮의 빈 결과는 6시간 기억');
  assert.equal(df.health().night, 0);
});

test('① 심야 경계 · 경우: 확인 못 함도 night · 키/한도 문제는 night 아님 · 근처에 정류장 자체가 없으면 night 아님 · 찾았으면 night 없이 6시간', async () => {
  const at = (iso) => new Date(iso).getTime();
  const one = async (t, o = {}) => createNearKuFinder({ provider: stub(o), clock: () => t }).find(37.6, 127.0);
  assert.equal((await one(at('2026-11-24T13:59:00Z'))).night, undefined, '22:59는 아님');
  assert.equal((await one(at('2026-11-24T14:00:00Z'))).night, true, '23:00부터');
  assert.equal((await one(at('2026-11-24T19:29:00Z'))).night, true, '04:29까지');
  assert.equal((await one(at('2026-11-24T19:30:00Z'))).night, undefined, '04:30부터 아님');
  // 모두 일시 실패 → '확인하지 못했어요'도 심야면 night(1분 기억은 원래도)
  assert.deepEqual(await one(NIGHT_2340, { fail: STOPS.map((s) => s.arsId) }), { ok: false, reason: 'api', stops: [], night: true });
  // 서울시 한도 · 키 문제 → night를 붙이지 않음(밤이라서가 아님)
  assert.deepEqual(await one(NIGHT_2340, { quota: '10001' }), { ok: false, reason: 'quota', stops: [] });
  // 400m 안에 정류장이 하나도 없으면 운행과 상관없으니 night 없음
  assert.deepEqual(await one(NIGHT_2340, { stops: [] }), { ok: true, stops: [], radiusM: 400 });
  // 심야에도 찾았으면 night 없이 6시간 기억
  const clock = { t: NIGHT_2340 };
  const p = stub({ ku: ['10003'] });
  const f = createNearKuFinder({ provider: p, clock: () => clock.t });
  const r = await f.find(37.6, 127.0);
  assert.deepEqual([r.ok, r.stops.map((s) => s.arsId), r.night], [true, ['10003'], undefined]);
  clock.t += 61_000;
  await f.find(37.6, 127.0);
  assert.equal(p.calls.length, 6, '찾은 결과는 6시간 기억');
});

const service = ({ reply, env = {}, clock = { t: DAY_1300 } } = {}) => {
  const fetchImpl = fakeGeminiFetch(reply ? { reply } : {});
  return { svc: createExplainService({ env: { GEMINI_API_KEY: 'GEMINI-TEST-SECRET-KEY', ...env }, fetchImpl, clock: () => clock.t }), fetchImpl, clock };
};

test('② 이중 차단 · 지시문: 원인을 잇는 말을 쓰지 말라고 하고, 예시 답은 검사를 통과 · 쓰지 말 것으로 든 문장은 모두 원인을 단정(causal)', () => {
  assert.match(SYSTEM_PROMPT, /원인과 결과를 잇는 말\(때문에, ~해서, ~와서, ~라서, ~로 인해, 탓에, 겹쳐, ~니까/);
  assert.ok(!SYSTEM_PROMPT.includes('출력 정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.'), '예전 예시 답(단정)은 없음');
  const outs = SYSTEM_PROMPT.split('\n').filter((l) => l.trim().startsWith('출력 ')).map((l) => l.trim().slice(3));
  assert.deepEqual(outs, ['정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.', '정릉로가 조금 막혀요. 특이 원인은 확인되지 않았어요.']);
  assert.equal(cleanAiText(outs[0], EXAMPLE_FACTS).ok, true);
  assert.equal(cleanAiText(outs[1], { ...EXAMPLE_FACTS, '막힘 정도': '보통', '느린 정도': '조금 느림', 날씨: null, '주변 돌발정보': [] }).ok, true);
  const bad = SYSTEM_PROMPT.split('\n').find((l) => l.startsWith('쓰지 말 것')).replace(/^쓰지 말 것\([^)]*\)\s*/, '').split(' / ');
  assert.equal(bad.length, 3);
  for (const s of bad) assert.deepEqual(cleanAiText(s, EXAMPLE_FACTS), { ok: false, why: 'causal' }, s);
});

test('② 이중 차단 · 검사: AI가 원인을 단정하면 기본 안내(reason causal) · 같은 상황은 5분 동안 다시 묻지 않음 · 다른 상황은 물음 · 전체를 쉬지 않음 · 오늘 거른 수', async () => {
  const { svc, fetchImpl, clock } = service({ reply: (f) => (f.날씨 === '눈' ? '정릉로가 막히고 있어요. 눈 영향일 수 있어요.' : causalSentenceFor(f)) });
  const r = await svc.explain(EXAMPLE_FACTS);
  assert.deepEqual([r.source, r.reason, r.text], ['rule', 'causal', ruleText(EXAMPLE_FACTS)]);
  assert.equal(r.text, '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.');
  assert.deepEqual([svc.health().lastError.kind, svc.health().cooldownUntil], ['causal', null], '내용 문제라 전체를 쉬지 않음');
  clock.t += 2 * MIN;
  assert.equal((await svc.explain(EXAMPLE_FACTS)).reason, 'causal');
  assert.equal(fetchImpl.calls.length, 1, '같은 상황은 다시 묻지 않음(호출 수가 늘지 않음)');
  const snow = await svc.explain({ ...EXAMPLE_FACTS, 날씨: '눈', '주변 돌발정보': [] });
  assert.deepEqual([snow.source, snow.text, fetchImpl.calls.length], ['gemini', '정릉로가 막히고 있어요. 눈 영향일 수 있어요.', 2]);
  const h = svc.health();
  assert.deepEqual([h.rejected, h.cooldownUntil], [{ causal: 1 }, null]);
  assert.ok(!JSON.stringify(h).includes('겹쳐'), 'health에는 문장을 싣지 않음(거른 수만)');
  // 가능성으로 끝나도 원인을 이으면 버림(더 보수적) · 다음 날(서울 자정) 거른 수는 0부터
  const hedged = service({ reply: () => '정릉로에 비가 와서 버스가 느릴 수 있어요.' });
  assert.equal((await hedged.svc.explain(EXAMPLE_FACTS)).reason, 'causal');
  hedged.clock.t = new Date('2026-11-24T15:00:00Z').getTime(); // 서울 수 00:00
  assert.deepEqual(hedged.svc.health().rejected, {});
});

test('⑤ Gemini 기본 4초 · .env.example은 값 비움(Render에 예전 3500이 있으면 그 값이 쓰임)', () => {
  assert.equal(service().svc.health().timeoutMs, 4000);
  assert.equal(service({ env: { GEMINI_TIMEOUT_MS: '3500' } }).svc.health().timeoutMs, 3500);
  assert.equal(service().svc.health().waitMs, 1200, '화면은 여전히 1.2초만 기다림');
  const ex = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(ex, /^GEMINI_TIMEOUT_MS=$/m);
});

test('② /api: AI가 원인을 단정하면 노선 설명은 기본 안내(causal) · /api/health explain.rejected · timeoutMs 4000', async () => {
  const now = () => new Date(DAY_1300);
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: 'TESTKEY' }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet });
  const incidents = createAccidentService({ env: { SEOUL_ACCIDENT_API_KEY: 'ACC' }, fetchImpl: fakeAccidentFetch(), clock: () => DAY_1300 });
  const weather = createWeatherService({ env: { KMA_API_KEY: 'KMA' }, fetchImpl: fakeKmaFetch(), clock: () => DAY_1300 });
  const explainer = createExplainService({ env: { GEMINI_API_KEY: 'GEMINI-TEST-SECRET-KEY' }, fetchImpl: fakeGeminiFetch({ reply: (f) => causalSentenceFor(f) }), clock: () => DAY_1300 });
  const app = createApp({ store: createStore(null), provider, pusher: { enabled: false, publicKey: null, send: async () => [] }, now, incidents, weather, explainer });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const j = await (await fetch(`${base}/api/stops/08901/trips`)).json();
    const slow = j.trips.filter((t) => t.explain);
    assert.ok(slow.length >= 1);
    for (const t of slow) assert.deepEqual([t.explain.source, t.explain.reason, t.explain.text], ['rule', 'causal', ruleText(t.explain.facts)], t.no);
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.ok(h.explain.rejected.causal >= 1);
    assert.equal(h.explain.timeoutMs, 4000);
    assert.ok(!JSON.stringify(h).includes('GEMINI-TEST-SECRET-KEY'));
  } finally { srv.close(); provider.stop?.(); }
});
