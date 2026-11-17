// 테스트용 가짜 ODsay 서버(searchPubTransPathT). 응답 모양은 ODsay 가이드의 예시 구조 그대로(shared/samples/odsaySample.js), 값은 예시입니다.
//   키가 틀리거나(+를 인코딩하지 않으면 공백으로 바뀌어 틀림) Referer가 없으면 실제처럼 HTTP 200 + error 목록
import { SAMPLE_ODSAY_RESPONSE } from '../../../shared/samples/odsaySample.js';

export const ODSAY_TEST_KEY = 'ODSAY+TEST/KEY=';   // +, /, = 가 섞인 키(인코딩 확인용)
export const ODSAY_REFERER = 'https://ku-bus-ai.onrender.com';
const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });

/** @param {{ key?, referer?, respond?: (url: URL, call) => object|null }} o  respond가 값을 주면 그 응답(오류 흉내) */
export function fakeOdsayFetch({ key = ODSAY_TEST_KEY, referer = ODSAY_REFERER, respond } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const call = { url: u, raw: String(url), referer: init.headers?.Referer ?? init.headers?.referer ?? null };
    calls.push(call);
    if (u.hostname !== 'api.odsay.com' || u.pathname !== '/v1/api/searchPubTransPathT') return { ok: false, status: 404, text: async () => 'not found' };
    const custom = respond && respond(u, call);
    if (custom) return custom.status ? custom : ok(custom);
    if (u.searchParams.get('apiKey') !== key || call.referer !== referer) return ok({ error: [{ code: '500', message: '[ApiKeyAuthFailed] ApiKey authentication failed.' }] });
    return ok(SAMPLE_ODSAY_RESPONSE);
  };
  fn.calls = calls;
  return fn;
}
