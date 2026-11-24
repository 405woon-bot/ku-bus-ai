// 테스트용 가짜 Gemini API(generateContent). 응답 모양은 Gemini API 문서의 GenerateContentResponse
// (candidates[0].content.parts[].text · finishReason · modelVersion)를 따랐고, 문장 · 값은 모두 가상입니다(실제 AI 응답 아님).

/** 정상 응답 본문 */
export function geminiJson(text, { finishReason = 'STOP', modelVersion = 'gemini-3.5-flash-lite' } = {}) {
  return JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 420, candidatesTokenCount: 18, totalTokenCount: 438 },
    modelVersion, responseId: 'fixture',
  });
}
/** 오류 응답 본문(Google API 오류 모양) */
export const geminiError = (code, message, status) => JSON.stringify({ error: { code, message, status } });

/** 사실 JSON → 그럴듯한 한 줄(가짜 AI가 v2.2.6 지시문대로 쓴다고 가정 — 막히는 곳 먼저, 원인일 수 있는 것은 따로 '…영향일 수 있어요') */
const batchim = (w) => { const c = String(w).slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0; };
export function sentenceFor(f) {
  const place = f['가장 느린 도로'], wx = f.날씨, inc = (f['주변 돌발정보'] || [])[0];
  if (!place && !wx && !inc) return '특이 지연 원인은 확인되지 않았어요.';
  const iga = place ? (batchim(place) ? '이' : '가') : '';
  if (place && wx && inc) return `${place}${iga} 많이 막혀요. ${inc.종류}${batchim(inc.종류) ? '과' : '와'} ${wx} 영향일 수 있어요.`;
  if (place && (wx || inc)) return `${place}${iga} 막히고 있어요. ${wx || inc.종류} 영향일 수 있어요.`;
  if (place) return `${place}${iga} 막혀요. 특이 원인은 확인되지 않았어요.`;
  return `버스가 평소보다 느려요. ${wx || inc.종류} 영향일 수 있어요.`;
}
/** 원인을 결과에 이어 단정하는 문장(v2.2.6 검사에서 걸러야 함) — 예전 지시문 예시와 같은 모양 */
export function causalSentenceFor(f) {
  const place = f['가장 느린 도로'] || '도로', wx = f.날씨, inc = (f['주변 돌발정보'] || [])[0];
  return wx && inc ? `${place} ${inc.종류} 구간에 ${wx}까지 겹쳐 버스가 많이 막혀요.` : `${wx || inc?.종류 || '정체'} 때문에 버스가 느려요.`;
}

/**
 * fetch 대신 쓰는 가짜 Gemini. calls에 { url, headers, body, facts }를 남깁니다.
 * @param {{ reply?: (facts, call) => string | { status:number, body:string } | Promise<any>, delayMs?: number }} o
 *   reply가 글이면 200 정상 응답, { status, body }면 그대로. delayMs 동안 기다리며 중단(abort)되면 AbortError
 */
export function fakeGeminiFetch({ reply, delayMs = 0 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    const facts = JSON.parse(body.contents[0].parts[0].text);
    const call = { url: new URL(url), method: init.method, headers: init.headers, body, facts };
    calls.push(call);
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
    const r = reply ? await reply(facts, call) : sentenceFor(facts);
    if (typeof r === 'string') return { ok: true, status: 200, text: async () => geminiJson(r) };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
