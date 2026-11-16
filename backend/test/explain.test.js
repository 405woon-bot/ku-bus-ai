// "왜 늦나요?" AI 한 줄(Gemini): 요청 모양 · 키 보호 · 5분 캐시 · 기본 안내로 대체(실패 · 한도 · 시간 초과) · 지어내기 막기 · 하루 상한 · /api 연동
// 가짜 Gemini(test/fixtures/geminiFixture.js)만 씁니다. 실제 Google 서버에는 부르지 않습니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createLiveService } from '../src/transit/index.js';
import { createAccidentService } from '../src/transit/seoulAccident.js';
import { createWeatherService } from '../src/transit/kmaWeather.js';
import { DEFAULT_GEMINI_MODEL, EXAMPLE_FACTS, SYSTEM_PROMPT, createExplainService, generationConfigFor, parseGeminiResponse } from '../src/transit/geminiExplain.js';
import { NO_CAUSE_TEXT } from '../../shared/explain.js';
import { fakeSeoulFetch } from './fixtures/seoulFixture.js';
import { fakeAccidentFetch } from './fixtures/accidentFixture.js';
import { fakeKmaFetch } from './fixtures/kmaFixture.js';
import { fakeGeminiFetch, geminiError, geminiJson } from './fixtures/geminiFixture.js';

const MON_0810 = new Date('2026-11-08T23:10:00Z'); // 서울 월 08:10
const T0 = MON_0810.getTime();
const MIN = 60_000;
const KEY = 'GEMINI-TEST-SECRET-KEY';
const quiet = { warn() {}, info() {}, error() {} };
const F = (over = {}) => ({ ...EXAMPLE_FACTS, ...over });
const ROAD_ONLY = F({ 날씨: null, '주변 돌발정보': [] });
const NOTHING = F({ '가장 느린 도로': null, 날씨: null, '주변 돌발정보': [] });

function service({ key = KEY, fetchImpl = fakeGeminiFetch(), env = {} } = {}) {
  const clock = { t: T0 };
  const svc = createExplainService({ env: { GEMINI_API_KEY: key, ...env }, fetchImpl, clock: () => clock.t });
  return { svc, clock, fetchImpl };
}

test('요청 모양: 기본 모델 gemini-3.5-flash-lite · v1beta generateContent · 키는 x-goog-api-key 헤더로만 · 사실 JSON만 보냄', async () => {
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
  const { svc, fetchImpl } = service();
  const r = await svc.explain(EXAMPLE_FACTS);
  assert.deepEqual([r.source, r.text, r.model], ['gemini', '정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.', 'gemini-3.5-flash-lite']);
  const c = fetchImpl.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url.href, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(c.headers['x-goog-api-key'], KEY);
  assert.ok(!c.url.href.includes(KEY), '주소(쿼리)에 키를 넣지 않음');
  assert.equal(c.body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
  assert.deepEqual(c.facts, EXAMPLE_FACTS);
  assert.deepEqual(c.body.generationConfig, { maxOutputTokens: 1024 }, '3.x는 temperature · thinkingBudget을 보내지 않음');
  assert.ok(!/\d/.test(c.body.contents[0].parts[0].text), 'AI에 넘기는 사실에는 숫자가 없음');
});

test('모델 바꾸기(GEMINI_MODEL): 주소가 바뀌고, 2.5 Flash는 생각 끄기(thinkingBudget 0)', async () => {
  const { svc, fetchImpl } = service({ env: { GEMINI_MODEL: 'gemini-2.5-flash' } });
  assert.equal((await svc.explain(EXAMPLE_FACTS)).model, 'gemini-2.5-flash');
  assert.match(fetchImpl.calls[0].url.pathname, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.deepEqual(fetchImpl.calls[0].body.generationConfig, { temperature: 0.2, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } });
  assert.deepEqual(generationConfigFor('gemini-2.5-flash-lite'), { temperature: 0.2, maxOutputTokens: 256 });
  assert.deepEqual(generationConfigFor('gemini-3.8-flash'), { maxOutputTokens: 1024 });
  assert.equal(service({ env: { GEMINI_MODEL: '  ' } }).svc.model, DEFAULT_GEMINI_MODEL, '빈 값이면 기본 모델');
});

test('응답 해석: 문장 · 모델 버전, 생각(thought) 조각은 빼고, 막힘 · 빈 응답 · 길이 한도 잘림은 오류', () => {
  assert.deepEqual(parseGeminiResponse(JSON.parse(geminiJson('정릉로가 막혀요.', { modelVersion: 'gemini-3.5-flash-lite-001' }))), { text: '정릉로가 막혀요.', modelVersion: 'gemini-3.5-flash-lite-001' });
  const withThought = { candidates: [{ content: { parts: [{ text: '생각 중…', thought: true }, { text: '정릉로가 막혀요.' }] }, finishReason: 'STOP' }] };
  assert.equal(parseGeminiResponse(withThought).text, '정릉로가 막혀요.');
  assert.throws(() => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), (e) => e.kind === 'blocked');
  assert.throws(() => parseGeminiResponse({ candidates: [{ finishReason: 'SAFETY' }] }), (e) => e.kind === 'blocked');
  assert.throws(() => parseGeminiResponse({ candidates: [] }), (e) => e.kind === 'empty');
  assert.throws(() => parseGeminiResponse(JSON.parse(geminiJson('정릉로 공사 구간에', { finishReason: 'MAX_TOKENS' }))), (e) => e.kind === 'format');
});

test('근거가 없으면 AI를 부르지 않고 고정 문장 · 예시 데이터면 기본 안내(예시) · 키가 없으면 기본 안내', async () => {
  const { svc, fetchImpl } = service();
  assert.deepEqual(await svc.explain(NOTHING), { source: 'rule', reason: 'no-evidence', text: NO_CAUSE_TEXT });
  assert.deepEqual(await svc.explain(EXAMPLE_FACTS, { example: true }), { source: 'example', reason: 'example', text: '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.' });
  assert.equal(fetchImpl.calls.length, 0);
  const nokey = service({ key: '' });
  assert.deepEqual(await nokey.svc.explain(EXAMPLE_FACTS), { source: 'rule', reason: 'no-key', text: '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.' });
  assert.equal(nokey.fetchImpl.calls.length, 0);
  assert.equal(nokey.svc.health().keyConfigured, false);
});

test('캐시: 같은 사실이면 5분 동안 다시 묻지 않음(EXPLAIN_CACHE_SEC 180~900) · 동시에 물어도 한 번 · 사실이 다르면 새로 물음', async () => {
  const { svc, clock, fetchImpl } = service();
  const [a, b] = await Promise.all([svc.explain(EXAMPLE_FACTS), svc.explain(F())]);
  assert.deepEqual([a.source, b.source, fetchImpl.calls.length], ['gemini', 'gemini', 1]);
  clock.t += 4 * MIN;
  assert.equal((await svc.explain(EXAMPLE_FACTS)).cached, true);
  assert.equal(fetchImpl.calls.length, 1);
  await svc.explain(ROAD_ONLY);
  assert.equal(fetchImpl.calls.length, 2, '날씨 · 돌발이 다르면 다른 상황');
  clock.t += 1.5 * MIN;
  assert.equal((await svc.explain(EXAMPLE_FACTS)).cached, false, '5분이 지나면 다시 물음');
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(service({ env: { EXPLAIN_CACHE_SEC: '60' } }).svc.health().cacheSec, 180, '최소 3분');
  assert.equal(service({ env: { EXPLAIN_CACHE_SEC: '9999' } }).svc.health().cacheSec, 900, '최대 15분');
});

test('한도 초과(429): 기본 안내로 바로 바꾸고 30분 동안 부르지 않음 → 30분 뒤 다시', async () => {
  let quota = true;
  const fetchImpl = fakeGeminiFetch({ reply: (f) => (quota ? { status: 429, body: geminiError(429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED') } : '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.') });
  const { svc, clock } = service({ fetchImpl });
  assert.deepEqual(await svc.explain(EXAMPLE_FACTS), { source: 'rule', reason: 'quota', text: '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.', model: DEFAULT_GEMINI_MODEL });
  const h = svc.health();
  assert.equal(h.lastError.kind, 'quota');
  assert.equal(h.cooldownUntil, new Date(T0 + 30 * MIN).toISOString());
  clock.t += 20 * MIN;
  assert.equal((await svc.explain(ROAD_ONLY)).reason, 'quota', '쉬는 동안은 다른 사실도 부르지 않음');
  assert.equal(fetchImpl.calls.length, 1);
  quota = false; clock.t += 11 * MIN;
  assert.equal((await svc.explain(EXAMPLE_FACTS)).source, 'gemini');
  assert.equal(svc.health().lastError, null);
});

test('그 밖의 실패: 서버 오류 · 네트워크 · 해석 불가는 1분, 키 오류(401/403) · 모델 없음(404) · 요청 오류(400)는 10분 쉼', async () => {
  const cases = [
    [{ status: 500, body: geminiError(500, 'Internal error', 'INTERNAL') }, 'server', 1],
    [{ status: 503, body: 'Service Unavailable' }, 'server', 1],
    [{ status: 200, body: '<html>oops</html>' }, 'parse', 1],
    [{ status: 403, body: geminiError(403, `Method doesn't allow unregistered callers. key=${KEY}`, 'PERMISSION_DENIED') }, 'auth', 10],
    [{ status: 400, body: geminiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT') }, 'bad-request', 10],
    [{ status: 404, body: geminiError(404, 'models/gemini-9 is not found for API version v1beta', 'NOT_FOUND') }, 'model', 10],
  ];
  for (const [reply, kind, coolMin] of cases) {
    const { svc, clock, fetchImpl } = service({ fetchImpl: fakeGeminiFetch({ reply: () => reply }) });
    const r = await svc.explain(EXAMPLE_FACTS);
    assert.deepEqual([r.source, r.reason], ['rule', kind], kind);
    assert.equal(svc.health().cooldownUntil, new Date(T0 + coolMin * MIN).toISOString(), kind);
    clock.t += coolMin * MIN - 1000;
    await svc.explain(EXAMPLE_FACTS);
    assert.equal(fetchImpl.calls.length, 1, `${kind}: 쉬는 동안 다시 부르지 않음`);
  }
  const model = service({ fetchImpl: fakeGeminiFetch({ reply: () => ({ status: 404, body: geminiError(404, 'not found', 'NOT_FOUND') }) }) });
  await model.svc.explain(EXAMPLE_FACTS);
  assert.match(model.svc.health().lastError.message, /GEMINI_MODEL/, '모델 이름을 바꾸라고 안내');
  const net = service({ fetchImpl: async () => { throw new TypeError(`fetch failed ${KEY}`); } });
  assert.equal((await net.svc.explain(EXAMPLE_FACTS)).reason, 'network');
  assert.ok(!JSON.stringify(net.svc.health()).includes(KEY), '오류 메시지에 키가 남지 않음');
});

test('시간 초과: 3.5초(GEMINI_TIMEOUT_MS, 1~4초) 넘으면 끊고 기본 안내 · 화면은 AI를 오래 기다리지 않음(pending → 다음 갱신에 AI 문장)', async () => {
  const slow = service({ fetchImpl: fakeGeminiFetch({ delayMs: 1500 }), env: { GEMINI_TIMEOUT_MS: '1000' } });
  assert.equal(slow.svc.health().timeoutMs, 1000);
  const t = await slow.svc.explain(EXAMPLE_FACTS, { wait: 1300 });
  assert.deepEqual([t.source, t.reason], ['rule', 'timeout']);
  assert.equal(service({ env: { GEMINI_TIMEOUT_MS: '9000' } }).svc.health().timeoutMs, 4000, '최대 4초');
  assert.equal(service().svc.health().timeoutMs, 3500, '기본 3.5초');
  // 화면 응답은 EXPLAIN_WAIT_MS만 기다림 → 기본 안내 + pending, 늦게 온 AI 문장은 캐시 → 다음 요청에 나옴
  const late = service({ fetchImpl: fakeGeminiFetch({ delayMs: 200 }), env: { EXPLAIN_WAIT_MS: '30' } });
  const first = await late.svc.explain(EXAMPLE_FACTS);
  assert.deepEqual([first.source, first.reason, first.pending, first.text], ['rule', 'pending', true, '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.']);
  await new Promise((r) => setTimeout(r, 300));
  const second = await late.svc.explain(EXAMPLE_FACTS);
  assert.deepEqual([second.source, second.cached, late.fetchImpl.calls.length], ['gemini', true, 1]);
});

test('지어내기 막기: 숫자 · 사실에 없는 원인 · 잘린 문장이면 버리고 기본 안내, 같은 사실은 5분 동안 다시 묻지 않음(다른 사실은 물음)', async () => {
  const bad = { [JSON.stringify(EXAMPLE_FACTS)]: '정릉로가 막혀 11분 늦어요.', [JSON.stringify(ROAD_ONLY)]: '정릉로 사고 때문에 막혀요.' };
  const fetchImpl = fakeGeminiFetch({ reply: (f) => bad[JSON.stringify(f)] ?? '정릉로에 비 영향이 겹쳐 막히는 것 같아요.' });
  const { svc, clock } = service({ fetchImpl });
  assert.deepEqual(await svc.explain(EXAMPLE_FACTS), { source: 'rule', reason: 'ungrounded', text: '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.', model: DEFAULT_GEMINI_MODEL });
  assert.equal((await svc.explain(ROAD_ONLY)).text, '정릉로가 막혀요. 특이 원인은 확인되지 않았어요.');
  assert.equal(svc.health().cooldownUntil, null, '내용 문제는 전체를 쉬게 하지 않음');
  clock.t += 2 * MIN;
  assert.equal((await svc.explain(EXAMPLE_FACTS)).reason, 'ungrounded');
  assert.equal(fetchImpl.calls.length, 2, '같은 사실은 다시 묻지 않음');
  assert.equal((await svc.explain(F({ '주변 돌발정보': [] }))).source, 'gemini', '다른 사실은 계속 물음');
  const cut = service({ fetchImpl: fakeGeminiFetch({ reply: () => ({ status: 200, body: geminiJson('정릉로 공사 구간에', { finishReason: 'MAX_TOKENS' }) }) }) });
  assert.equal((await cut.svc.explain(EXAMPLE_FACTS)).reason, 'format');
});

test('하루 상한(GEMINI_MAX_PER_DAY): 넘으면 그날은 기본 안내 → 한국 시각 자정에 초기화', async () => {
  const { svc, clock, fetchImpl } = service({ env: { GEMINI_MAX_PER_DAY: '2' } });
  await svc.explain(EXAMPLE_FACTS);
  await svc.explain(ROAD_ONLY);
  assert.equal((await svc.explain(F({ 날씨: '눈' }))).reason, 'cap');
  assert.deepEqual([fetchImpl.calls.length, svc.health().callsToday, svc.health().maxPerDay], [2, 2, 2]);
  clock.t = new Date('2026-11-09T15:00:00Z').getTime(); // 서울 화 00:00
  assert.equal((await svc.explain(F({ 날씨: '눈' }))).source, 'gemini');
  assert.equal(svc.health().callsToday, 1);
});

test('노선별: 지연 분은 모두에게, 설명은 보통 · 혼잡에만(근거 facts 포함), 같은 사실이면 한 번만 물음', async () => {
  const { svc, fetchImpl } = service();
  const trips = [
    { no: '171', congestion: 'heavy', cause: '정릉로', slowest: { kmh: 4 }, kmh: 6.4, distM: 1780, inVehicleMin: 17.8, intermediateStops: 3 },
    { no: '1711', congestion: 'heavy', cause: '정릉로', slowest: { kmh: 4 }, kmh: 8, distM: 1680, inVehicleMin: 12, intermediateStops: 2 },
    { no: '1112', congestion: 'smooth', cause: null, slowest: null, kmh: 24, distM: 1730, inVehicleMin: 5, intermediateStops: 2 },
  ];
  const out = await svc.forTrips(trips, { weather: { source: 'kma', wet: true, pty: 1, ptyText: '비' } });
  assert.deepEqual(out.map((t) => [t.no, t.delayMin, t.explain?.source ?? null]), [['171', 11, 'gemini'], ['1711', 6, 'gemini'], ['1112', 0, null]]);
  assert.equal(fetchImpl.calls.length, 1, '171 · 1711은 사실이 같아 한 번만');
  assert.deepEqual(out[0].explain.facts, { '막힘 정도': '혼잡', '가장 느린 도로': '정릉로', '느린 정도': '걷는 속도 수준으로 느림', 날씨: '비', '주변 돌발정보': [] });
  // 예시 데이터(버스가 예시) → 부르지 않고 예시 안내
  const ex = await svc.forTrips([{ no: '171', congestion: 'heavy', cause: '정릉로', distM: null, kmh: NaN, inVehicleMin: 14, example: true }], { example: true });
  assert.deepEqual([ex[0].delayMin, ex[0].explain.source, ex[0].explain.text], [null, 'example', '정릉로가 막혀요. 특이 원인은 확인되지 않았어요.']);
  assert.equal(fetchImpl.calls.length, 1);
});

test('키 보호 · 확인용 test(): 상태 · 결과 어디에도 키가 없고, 예시 사실(실시간 아님)로 물어본 결과를 돌려줌', async () => {
  const { svc } = service();
  const t = await svc.test();
  assert.deepEqual([t.example, t.model, t.keyConfigured, t.result.source], [true, DEFAULT_GEMINI_MODEL, true, 'gemini']);
  assert.match(t.note, /실시간 아님/);
  assert.equal(t.noEvidenceText, NO_CAUSE_TEXT);
  const h = svc.health();
  assert.deepEqual([h.keyConfigured, h.model, h.callsToday, h.lastText], [true, DEFAULT_GEMINI_MODEL, 1, '정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.']);
  assert.ok(!JSON.stringify([t, h]).includes(KEY));
});

async function serve({ busKey = 'TESTKEY', geminiKey = KEY, geminiFetch = fakeGeminiFetch(), withExplainer = true } = {}, fn) {
  const now = () => MON_0810;
  const provider = createLiveService({ env: { SEOUL_BUS_API_KEY: busKey }, fetchImpl: fakeSeoulFetch(), background: false, log: quiet });
  const incidents = createAccidentService({ env: { SEOUL_ACCIDENT_API_KEY: 'ACC' }, fetchImpl: fakeAccidentFetch(), clock: () => T0 });
  const weather = createWeatherService({ env: { KMA_API_KEY: 'KMA' }, fetchImpl: fakeKmaFetch(), clock: () => T0 });
  const explainer = withExplainer ? createExplainService({ env: { GEMINI_API_KEY: geminiKey }, fetchImpl: geminiFetch, clock: () => T0 }) : null;
  const app = createApp({ store: createStore(null), provider, pusher: { enabled: false, publicKey: null, send: async () => [] }, now, incidents, weather, explainer });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  try { await fn(get, geminiFetch); } finally { srv.close(); provider.stop?.(); }
}

test('/api/stops/:arsId/trips: 노선마다 delayMin, 막히는 노선에 explain(AI 문장 + 근거) · /api/explain/test · /api/health', async () => {
  await serve({}, async (get, geminiFetch) => {
    const j = await get('/api/stops/08901/trips');
    const by = Object.fromEntries(j.trips.map((t) => [t.no, t]));
    assert.deepEqual(['171', '1711', '1112'].map((n) => [by[n].congestion, by[n].delayMin, by[n].explain?.source]),
      [['heavy', 11, 'gemini'], ['heavy', 6, 'gemini'], ['normal', 1, 'gemini']]);
    assert.equal(by['171'].explain.text, '정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.');
    assert.deepEqual(by['171'].explain.facts['주변 돌발정보'].map((i) => i.종류), ['공사'], '예정된 행사(T-EVENT)는 사실에서 뺌');
    assert.equal(by['1711'].explain.facts['가장 느린 도로'], '정릉3동주민센터앞~청덕초등학교입구 구간');
    assert.equal(by['1711'].explain.text, '정릉3동주민센터앞~청덕초등학교입구 구간 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.', '이름에 든 숫자는 통과');
    assert.equal(geminiFetch.calls.length, 3);
    await get('/api/stops/08901/trips');
    assert.equal(geminiFetch.calls.length, 3, '20초 뒤 다시 불러도 5분 캐시');
    const t = await get('/api/explain/test');
    assert.deepEqual([t.example, t.result.source, t.result.text], [true, 'gemini', '정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.']);
    const h = await get('/api/health');
    assert.deepEqual([h.explain.keyConfigured, h.explain.model, h.explain.callsToday], [true, 'gemini-3.5-flash-lite', 4], '노선 3번 + 확인용 1번');
    assert.ok(!JSON.stringify([j, t, h]).includes(KEY));
  });
  // Gemini가 실패해도 버스 정보는 그대로, 설명은 기본 안내
  await serve({ geminiFetch: fakeGeminiFetch({ reply: () => ({ status: 429, body: geminiError(429, 'quota', 'RESOURCE_EXHAUSTED') }) }) }, async (get) => {
    const j = await get('/api/stops/08901/trips');
    assert.equal(j.source, 'seoul');
    const t171 = j.trips.find((t) => t.no === '171');
    assert.deepEqual([t171.explain.source, t171.explain.reason, t171.explain.text], ['rule', 'quota', '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.']);
    assert.equal((await get('/api/health')).explain.lastError.kind, 'quota');
  });
  // 키 없음 → 기본 안내, 버스가 예시 데이터 → 예시 안내(부르지 않음)
  await serve({ geminiKey: '' }, async (get) => {
    const j = await get('/api/stops/08901/trips');
    assert.ok(j.trips.filter((t) => t.explain).every((t) => t.explain.source === 'rule' && t.explain.reason === 'no-key'));
    assert.equal((await get('/api/explain/test')).result.reason, 'no-key');
    assert.equal((await get('/api/health')).explain.keyConfigured, false);
  });
  await serve({ busKey: '' }, async (get, geminiFetch) => {
    const j = await get('/api/stops/08901/trips');
    assert.equal(j.source, 'mock');
    assert.ok(j.trips.filter((t) => t.explain).every((t) => t.explain.source === 'example'));
    assert.equal(geminiFetch.calls.length, 0);
  });
  // explainer 없이 만든 앱(예전 테스트 방식)도 delayMin은 붙음
  await serve({ withExplainer: false }, async (get) => {
    const j = await get('/api/stops/08901/trips');
    assert.equal(j.trips.find((t) => t.no === '171').delayMin, 11);
    assert.ok(j.trips.every((t) => !t.explain));
    assert.equal((await get('/api/explain/test')).result.source, 'off');
  });
});
