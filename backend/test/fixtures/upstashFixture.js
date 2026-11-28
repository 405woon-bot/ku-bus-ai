// 테스트용 가짜 Upstash Redis REST 서버(메모리). 요청 · 응답 모양은 Upstash REST API 문서 기준:
//   POST {주소} 본문 ["HSET", "키", "필드", "값", …] → { "result": 숫자 } / ["HGETALL", "키"] → { "result": [필드, 값, …] }
//   POST {주소}/pipeline 본문 [[…], […]] → [{ "result": … }, …] · 토큰이 틀리면 401 { "error": "Unauthorized" }

export const UPSTASH_URL = 'https://fake-redis.upstash.io';

/**
 * @param {{ token?: string, data?: Record<string, Record<string,string>>, fail?: (cmd: string[], call) => any, readonly?: boolean }} o
 */
export function fakeUpstashFetch({ token = 'UPSTASH-TEST-TOKEN', data = {}, fail, readonly = false, clock = () => Date.now() } = {}) {
  const calls = [];
  const db = data; // 해시 키 → { 필드: 값 } · 문자열 키 → { $s: 값, $exp: 만료(ms) }
  const str = (key) => { const e = db[key]; if (e && e.$exp && e.$exp <= clock()) { delete db[key]; return null; } return e && '$s' in e ? e : null; };
  function run(cmd) {
    const [name, key, ...rest] = cmd;
    const write = () => (readonly ? { error: `NOPERM this user has no permissions to run the '${String(name).toLowerCase()}' command` } : null);
    switch (String(name).toUpperCase()) {
      case 'HGETALL': return { result: Object.entries(db[key] || {}).filter(([f]) => !f.startsWith('$')).flat() };
      case 'HSET': {
        if (readonly) return write();
        const h = db[key] || (db[key] = {});
        let added = 0;
        for (let i = 0; i + 1 < rest.length; i += 2) { if (!(rest[i] in h)) added++; h[rest[i]] = rest[i + 1]; }
        return { result: added };
      }
      case 'HDEL': { if (readonly) return write(); const h = db[key] || {}; let n = 0; for (const f of rest) if (f in h) { delete h[f]; n++; } return { result: n }; }
      // 문자열 값: GET · SET(EX 초) · INCR · EXPIRE — ODsay 검색 결과 · 하루 호출 수
      case 'GET': return { result: str(key)?.$s ?? null };
      case 'SET': {
        if (readonly) return write();
        // v2.8.0 NX: 이미 있으면 저장하지 않고 null(Upstash · Redis와 같음)
        if (rest.some((x) => String(x).toUpperCase() === 'NX') && str(key)) return { result: null };
        const ex = rest.findIndex((x) => String(x).toUpperCase() === 'EX');
        db[key] = { $s: String(rest[0]), $exp: ex >= 0 ? clock() + Number(rest[ex + 1]) * 1000 : 0 };
        return { result: 'OK' };
      }
      case 'INCR': { if (readonly) return write(); const e = str(key); const n = (Number(e?.$s) || 0) + 1; db[key] = { $s: String(n), $exp: e?.$exp || 0 }; return { result: n }; }
      case 'EXPIRE': { const e = str(key); if (!e) return { result: 0 }; e.$exp = clock() + Number(rest[0]) * 1000; return { result: 1 }; }
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
