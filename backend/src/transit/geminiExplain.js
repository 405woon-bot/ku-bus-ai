// "왜 늦나요?" 한 줄 — Google Gemini API(REST generateContent)로 서버가 확인한 사실만 쉬운 문장으로 바꿉니다.
//
//   요청: POST https://generativelanguage.googleapis.com/v1beta/models/{모델}:generateContent
//         헤더 x-goog-api-key: 키(주소에 키를 넣지 않음) · 본문 systemInstruction + contents(사실 JSON) + generationConfig
//   키: 서버 환경변수 GEMINI_API_KEY에만. 모델: GEMINI_MODEL(기본 gemini-3.5-flash-lite — 구글이 새 프로젝트에 권장)
//   지키는 것
//   - 숫자는 서버가 계산(shared/explain.js의 delayMinutes)해 화면에 따로 보여 주고, AI에는 숫자 대신 말로 묶은 사실만 넘김
//   - 근거가 하나도 없으면 AI를 부르지 않고 '특이 지연 원인은 확인되지 않았어요.'
//   - AI 문장에 숫자 · 사실에 없는 원인이 나오면 버리고 기본 안내(ruleText)
//   - v2.2.6 원인을 결과에 잇는 말(때문에 · ~해서 · ~와서 · 겹쳐 · '공사로' 등)이 있으면 '~수 있어요'로 끝나도 버리고 기본 안내(이중 차단:
//     지시문에서 쓰지 말라고 하고, 받은 문장도 shared/explain.js의 hasCausalLink로 다시 검사) · 오늘 거른 수는 /api/health의 explain.rejected
//   - 실패 · 한도 초과(429) · 4초 초과(v2.2.6, 예전 3.5초) → 기본 안내로 즉시 대체. 화면 응답은 AI를 최대 1.2초만 기다리고(그 뒤 도착하면 캐시 → 다음 갱신에 반영)
//   - 같은 사실이면 5분 동안 메모리 캐시(노선이 달라도 사실이 같으면 공유) · 하루 호출 상한
//   - 한도 초과 뒤 30분 · 키/모델/요청 오류 뒤 10분 · 그 밖의 실패 뒤 1분 쉼(쉬는 동안은 부르지 않고 기본 안내)
import { NO_CAUSE_TEXT, cleanAiText, buildFacts, delayMinutes, hasEvidence, ruleText } from '../../../shared/explain.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const SYSTEM_PROMPT = [
  '너는 서울 국민대학교 등교 버스 앱의 "왜 늦나요?" 한 줄 문구 작성기다.',
  '입력은 서버가 확인한 사실 JSON 하나다. 다음 규칙을 반드시 지켜라.',
  '1. JSON에 있는 사실만 쓴다. JSON에 없는 원인(사고, 공사, 집회, 시위, 행사, 날씨, 신호, 출퇴근 등)은 절대 추측하거나 덧붙이지 않는다.',
  '2. 숫자, 시각, 분, 속도 값은 새로 쓰지 않는다. 숫자는 화면이 따로 보여 준다. 도로나 정류장 이름에 든 숫자는 이름 그대로 써도 된다.',
  '3. "가장 느린 도로"는 도로 이름이거나 "정류장~정류장 구간"이다. 첫 문장에는 어디가 막히는지만 쓴다.',
  '4. "날씨"와 "주변 돌발정보"는 원인일 수 있다고만, 다음 문장에서 따로 "…영향일 수 있어요"처럼 쓴다. 원인과 결과를 잇는 말(때문에, ~해서, ~와서, ~라서, ~로 인해, 탓에, 겹쳐, ~니까, "공사로 막혀요"처럼 원인 뒤에 붙는 "로")은 쓰지 않는다.',
  '5. "날씨"가 null이고 "주변 돌발정보"가 비어 있으면, 어디가 막히는지만 말하고 "특이 원인은 확인되지 않았어요"로 끝낸다.',
  '6. "가장 느린 도로", "날씨", "주변 돌발정보"가 모두 없으면 정확히 "특이 지연 원인은 확인되지 않았어요."라고만 쓴다.',
  '7. 대학생이 읽기 쉬운 해요체 한국어로 35자 안팎, 한두 문장으로 쓴다. 따옴표, 이모지, 줄바꿈, 머리말 없이 문장만 출력한다.',
  '예1) 입력 {"막힘 정도":"혼잡","가장 느린 도로":"정릉로","느린 정도":"걷는 속도 수준으로 느림","날씨":"비","주변 돌발정보":[{"종류":"공사","이름":"하수관 정비공사","위치":"경로 위","시점":"진행 중"}]}',
  '    출력 정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.',
  '예2) 입력 {"막힘 정도":"보통","가장 느린 도로":"정릉로","느린 정도":"조금 느림","날씨":null,"주변 돌발정보":[]}',
  '    출력 정릉로가 조금 막혀요. 특이 원인은 확인되지 않았어요.',
  '쓰지 말 것(원인을 결과에 이어 단정함) 정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요. / 비가 와서 버스가 느려요. / 공사 때문에 막혀요.',
].join('\n');

/** 확인용(/api/explain/test) 예시 사실 — 실시간 아님 */
export const EXAMPLE_FACTS = Object.freeze({
  '막힘 정도': '혼잡', '가장 느린 도로': '정릉로', '느린 정도': '걷는 속도 수준으로 느림', 날씨: '비',
  '주변 돌발정보': [{ 종류: '공사', 이름: '하수관 정비공사(예시)', 위치: '경로 위', 시점: '진행 중' }],
});

export class GeminiError extends Error {
  constructor(kind, message, status) { super(message); this.name = 'GeminiError'; this.kind = kind; this.status = status; }
}

/**
 * 모델에 맞는 생성 설정
 * - 2.5 Flash: 생각(thinking)을 꺼서(thinkingBudget 0) 빠르게 · 2.5 Flash-Lite: 원래 생각 안 함
 * - 3.x 등: Gemini 문서가 temperature · top_p를 기본값 그대로 두라고 권장해 보내지 않고 출력 길이만 정함.
 *   3.5 Flash-Lite는 기본이 '최소 생각(minimal)'이고, 생각 토큰도 출력 한도에 들어가므로 넉넉히 둠(비용은 실제로 쓴 만큼만)
 */
export function generationConfigFor(model) {
  const m = String(model);
  if (/^gemini-2\.5-flash-lite/.test(m)) return { temperature: 0.2, maxOutputTokens: 256 };
  if (/^gemini-2\.5-flash/.test(m)) return { temperature: 0.2, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } };
  if (/^gemini-2\./.test(m)) return { temperature: 0.2, maxOutputTokens: 1024 };
  return { maxOutputTokens: 1024 };
}

/** 응답 JSON → { text, modelVersion }. 막힘(안전 필터) · 빈 응답 · 길이 한도로 잘림이면 오류 */
export function parseGeminiResponse(j) {
  if (j?.promptFeedback?.blockReason) throw new GeminiError('blocked', `Gemini가 응답을 막았어요(${j.promptFeedback.blockReason})`);
  const c = j?.candidates?.[0];
  const text = (c?.content?.parts || []).filter((p) => !p?.thought).map((p) => p?.text || '').join('').trim();
  if (c?.finishReason === 'MAX_TOKENS') throw new GeminiError('format', 'Gemini 문장이 길이 한도에서 잘렸어요');
  if (!text) throw new GeminiError(c?.finishReason === 'SAFETY' ? 'blocked' : 'empty', `Gemini 응답에 문장이 없어요(${c?.finishReason || '빈 응답'})`);
  return { text, modelVersion: j?.modelVersion || null };
}

const kstDay = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const numEnv = (v, dflt) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? dflt : Number(v));
// 같은 사실로 다시 물어도 같은 결과일 오류 → 그 사실만 캐시 시간 동안 기본 안내(다른 사실은 계속 물음)
//   v2.2.6 'causal'(원인을 단정해 잇는 문장)도 여기에 — 같은 상황이면 5분 동안 다시 묻지 않아 호출 수가 늘지 않음
const CONTENT_ERRORS = ['ungrounded', 'causal', 'format', 'blocked', 'empty'];
// 설정을 고쳐야 풀리는 오류 → 10분 쉼
const CONFIG_ERRORS = ['auth', 'model', 'bad-request'];

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} [o.env] GEMINI_API_KEY · GEMINI_MODEL · GEMINI_TIMEOUT_MS(4000, 1000~4000 — v2.2.6 기본 3500 → 4000) · EXPLAIN_CACHE_SEC(300, 180~900)
 *                                    · GEMINI_MAX_PER_DAY(200) · EXPLAIN_WAIT_MS(1200, 0~시간 제한) · GEMINI_BASE_URL(테스트용)
 */
export function createExplainService({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now(),
  quotaCooldownMs = 30 * 60_000, configCooldownMs = 10 * 60_000, failCooldownMs = 60_000 } = {}) {
  const key = String(env.GEMINI_API_KEY || '').trim();
  const model = String(env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;
  const base = String(env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE).trim().replace(/\/+$/, '');
  const timeoutMs = clamp(numEnv(env.GEMINI_TIMEOUT_MS, 4000), 1000, 4000); // v2.2.6 첫 호출의 연결 지연을 감안해 기본 4초(화면은 여전히 EXPLAIN_WAIT_MS만 기다림)
  const cacheMs = clamp(numEnv(env.EXPLAIN_CACHE_SEC, 300), 180, 900) * 1000;
  const maxPerDay = Math.max(1, Math.round(numEnv(env.GEMINI_MAX_PER_DAY, 200)));
  const waitMs = clamp(numEnv(env.EXPLAIN_WAIT_MS, 1200), 0, timeoutMs);
  const st = { cache: new Map(), inflight: new Map(), day: kstDay(clock()), calls: 0, rejected: {}, lastOk: null, lastError: null, until: 0 };
  const redact = (s) => (key ? String(s).split(key).join('[KEY]') : String(s));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const cooldownFor = (kind) => (kind === 'quota' ? quotaCooldownMs : CONFIG_ERRORS.includes(kind) ? configCooldownMs : failCooldownMs);
  const rollDay = () => { const d = kstDay(clock()); if (d !== st.day) { st.day = d; st.calls = 0; st.rejected = {}; } };

  async function callGemini(facts) {
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(facts) }] }],
      generationConfig: generationConfigFor(model),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = clock();
    let res, text;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      if (e?.name === 'AbortError' || ctrl.signal.aborted) throw new GeminiError('timeout', `Gemini가 ${timeoutMs / 1000}초 안에 답하지 않았어요`);
      throw new GeminiError('network', `Gemini에 연결하지 못했어요(${redact(e?.message)})`);
    } finally { clearTimeout(timer); }
    let j = null;
    try { j = JSON.parse(text); } catch { /* 아래에서 처리 */ }
    if (!res.ok) {
      const msg = redact(j?.error?.message || `HTTP ${res.status}`).slice(0, 200);
      if (res.status === 429) throw new GeminiError('quota', `Gemini 호출 한도를 넘었어요(${msg})`, 429);
      if (res.status === 401 || res.status === 403) throw new GeminiError('auth', `Gemini 키 · 권한 오류(${msg})`, res.status);
      if (res.status === 404) throw new GeminiError('model', `모델 ${model}을(를) 쓸 수 없어요(${msg}) — GEMINI_MODEL을 확인하세요`, 404);
      if (res.status === 400) throw new GeminiError('bad-request', `Gemini 요청 오류(${msg})`, 400);
      throw new GeminiError('server', `Gemini 서버 오류(${msg})`, res.status);
    }
    if (!j) throw new GeminiError('parse', 'Gemini 응답을 해석하지 못했어요');
    const out = parseGeminiResponse(j);
    const clean = cleanAiText(out.text, facts);
    if (!clean.ok) {
      rollDay(); st.rejected[clean.why] = (st.rejected[clean.why] || 0) + 1; // v2.2.6 오늘 거른 수(까닭별)
      const kind = clean.why === 'ungrounded' || clean.why === 'number' ? 'ungrounded' : clean.why === 'causal' ? 'causal' : 'format';
      throw new GeminiError(kind, `AI 문장을 쓰지 않았어요(${clean.why})`);
    }
    return { text: clean.text, modelVersion: out.modelVersion, ms: clock() - t0 };
  }

  /** 같은 사실이면 캐시 · 동시에 같은 사실이면 한 번만 · 쉬는 중 · 하루 상한 확인 후 호출 */
  function aiText(facts) {
    const k = JSON.stringify(facts);
    const hit = st.cache.get(k);
    if (hit && clock() - hit.at < cacheMs) {
      return hit.fail ? Promise.reject(new GeminiError(hit.fail, '같은 상황에서 AI 문장을 쓰지 않았어요(캐시)')) : Promise.resolve({ ...hit, cached: true });
    }
    if (st.inflight.has(k)) return st.inflight.get(k);
    if (clock() < st.until) return Promise.reject(new GeminiError(st.lastError?.kind || 'cooldown', st.lastError?.message || '잠시 쉬는 중이에요'));
    rollDay();
    if (st.calls >= maxPerDay) return Promise.reject(new GeminiError('cap', `오늘 AI 설명 호출 상한(${maxPerDay}회)에 닿았어요`));
    st.calls++;
    const p = callGemini(facts)
      .then((v) => {
        const rec = { ...v, at: clock() };
        st.cache.set(k, rec);
        st.lastOk = { at: rec.at, text: rec.text, modelVersion: rec.modelVersion, ms: rec.ms };
        st.lastError = null;
        return { ...rec, cached: false };
      })
      .catch((e) => {
        const err = e instanceof GeminiError ? e : new GeminiError('api', redact(e?.message));
        st.lastError = { kind: err.kind, message: redact(err.message), at: clock() };
        if (CONTENT_ERRORS.includes(err.kind)) st.cache.set(k, { fail: err.kind, at: clock() });
        else st.until = clock() + cooldownFor(err.kind);
        throw err;
      })
      .finally(() => {
        st.inflight.delete(k);
        while (st.cache.size > 200) st.cache.delete(st.cache.keys().next().value);
      });
    st.inflight.set(k, p);
    p.catch(() => {});
    return p;
  }

  /**
   * 사실 하나 → 화면에 쓸 한 문장. 던지지 않습니다.
   * @returns {Promise<{ source:'gemini'|'rule'|'example', text, reason?, pending?, model?, cached? }>}
   *   reason: example(예시 데이터) · no-evidence(근거 없음) · no-key · pending(AI 기다리는 중, 다음 갱신에 반영)
   *           · timeout · quota · cap · auth · model · bad-request · server · network · ungrounded · format …
   */
  async function explain(facts, { example = false, wait = waitMs } = {}) {
    const rule = ruleText(facts);
    if (example) return { source: 'example', reason: 'example', text: rule };
    if (!hasEvidence(facts)) return { source: 'rule', reason: 'no-evidence', text: NO_CAUSE_TEXT };
    if (!key) return { source: 'rule', reason: 'no-key', text: rule };
    const WAIT = Symbol('wait');
    let timer;
    try {
      const r = await Promise.race([aiText(facts), new Promise((resolve) => { timer = setTimeout(() => resolve(WAIT), wait); timer.unref?.(); })]);
      if (r === WAIT) return { source: 'rule', reason: 'pending', pending: true, text: rule, model };
      return { source: 'gemini', text: r.text, model, cached: Boolean(r.cached) };
    } catch (e) {
      return { source: 'rule', reason: e?.kind || 'api', text: rule, model };
    } finally { clearTimeout(timer); }
  }

  /**
   * 노선별 지연 분(delayMin, 서버 계산) + 막힐 때(보통 · 혼잡)만 explain(+ 근거 facts). 같은 사실은 한 번만 AI에 물음.
   * @param {Array} trips @param {{ incidents?, weather?, example?: boolean }} ctx
   */
  async function forTrips(trips, { incidents, weather, example = false } = {}) {
    const byKey = new Map();
    const work = (trips || []).map((t) => {
      const delayMin = delayMinutes(t);
      if (!['normal', 'heavy'].includes(t?.congestion)) return { t: { ...t, delayMin } };
      const facts = buildFacts(t, { incidents, weather });
      const k = JSON.stringify(facts);
      if (!byKey.has(k)) byKey.set(k, explain(facts, { example }));
      return { t: { ...t, delayMin }, facts, k };
    });
    const done = new Map(await Promise.all([...byKey].map(async ([k, p]) => [k, await p])));
    return work.map(({ t, facts, k }) => (facts ? { ...t, explain: { ...done.get(k), facts } } : t));
  }

  /** 확인용: 예시 사실로 한 번 물어봄(캐시 · 상한 · 쉼은 그대로 적용, 시간 제한까지 기다림) */
  async function test() {
    const t0 = clock();
    const r = await explain(EXAMPLE_FACTS, { wait: timeoutMs + 300 });
    return {
      example: true, note: '예시 사실로 시험한 결과예요(실시간 아님)', model, keyConfigured: Boolean(key),
      facts: EXAMPLE_FACTS, result: { ...r, ms: clock() - t0 }, ruleText: ruleText(EXAMPLE_FACTS), noEvidenceText: NO_CAUSE_TEXT,
    };
  }

  return {
    explain,
    forTrips,
    test,
    get model() { return model; },
    health() {
      rollDay();
      return {
        keyConfigured: Boolean(key), model, timeoutMs, waitMs, cacheSec: cacheMs / 1000, maxPerDay, callsToday: st.calls,
        rejected: { ...st.rejected }, // v2.2.6 오늘 검사에서 거른 AI 문장 수(causal = 원인을 단정해 이음 · ungrounded · number · format · long · empty) — 문장은 싣지 않음
        lastOkAt: iso(st.lastOk?.at), lastText: st.lastOk?.text ?? null, lastModelVersion: st.lastOk?.modelVersion ?? null, lastMs: st.lastOk?.ms ?? null,
        lastError: st.lastError && { ...st.lastError, at: iso(st.lastError.at) }, cooldownUntil: st.until > clock() ? iso(st.until) : null,
      };
    },
  };
}
