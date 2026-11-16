// 테스트용 가짜 Upstash Redis REST 서버(메모리). 요청 · 응답 모양은 Upstash REST API 문서 기준:
//   POST {주소} 본문 ["HSET", "키", "필드", "값", …] → { "result": 숫자 } / ["HGETALL", "키"] → { "result": [필드, 값, …] }
//   POST {주소}/pipeline 본문 [[…], […]] → [{ "result": … }, …] · 토큰이 틀리면 401 { "error": "Unauthorized" }

export const UPSTASH_URL = 'https://fake-redis.upstash.io';

/**
 * @param {{ token?: string, data?: Record<string, Record<string,string>>, fail?: (cmd: string[], call) => any, readonly?: boolean }} o
 */
export function fakeUpstashFetch({ token = 'UPSTASH-TEST-TOKEN', data = {}, fail, readonly = false } = {}) {
  const calls = [];
  const db = data; // 키 → { 필드: 값 }
  function run(cmd) {
    const [name, key, ...rest] = cmd;
    switch (String(name).toUpperCase()) {
      case 'HGETALL': return { result: Object.entries(db[key] || {}).flat() };
      case 'HSET': {
        if (readonly) return { error: "NOPERM this user has no permissions to run the 'hset' command" };
        const h = db[key] || (db[key] = {});
        let added = 0;
        for (let i = 0; i + 1 < rest.length; i += 2) { if (!(rest[i] in h)) added++; h[rest[i]] = rest[i + 1]; }
        return { result: added };
      }
      case 'PING': return { result: 'PONG' };
      default: return { error: `ERR unknown command '${name}'` };
    }
  }
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const body = JSON.parse(init.body);
    const call = { url: u, auth: init.headers?.authorization, body };
    calls.push(call);
    const custom = fail && (await fail(body, call));
    if (custom) return custom;
    if (call.auth !== `Bearer ${token}`) return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'Unauthorized' }) };
    if (u.pathname === '/pipeline') return { ok: true, status: 200, text: async () => JSON.stringify(body.map(run)) };
    const r = run(body);
    return { ok: !r.error, status: r.error ? 400 : 200, text: async () => JSON.stringify(r) };
  };
  fn.calls = calls;
  fn.db = db;
  return fn;
}
