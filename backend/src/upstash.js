// Upstash Redis REST API — 패키지 설치 없이 fetch(https 요청 하나)로 Redis 명령을 보냅니다.
//   주소 · 토큰: 서버 환경변수 UPSTASH_REDIS_REST_URL · UPSTASH_REDIS_REST_TOKEN (토큰은 Authorization: Bearer 헤더로만 보냄)
//   명령 하나: POST {주소}  본문 ["HSET", "키", "필드", "값"]  → { "result": … } 또는 { "error": "…" }
//   여러 명령: POST {주소}/pipeline  본문 [["…"], ["…"]] → [{ "result": … }, …]

export class UpstashError extends Error {
  constructor(kind, message, status) { super(message); this.name = 'UpstashError'; this.kind = kind; this.status = status; }
}

/**
 * @param {{ url?: string, token?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} o
 */
export function createUpstash({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  const tok = String(token || '').trim();
  const redact = (s) => (tok ? String(s ?? '').split(tok).join('[TOKEN]') : String(s ?? ''));

  async function post(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetchImpl(base + path, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      if (e?.name === 'AbortError' || ctrl.signal.aborted) throw new UpstashError('timeout', `Upstash가 ${timeoutMs / 1000}초 안에 답하지 않았어요`);
      throw new UpstashError('network', `Upstash에 연결하지 못했어요(${redact(e?.message).slice(0, 120)})`);
    } finally { clearTimeout(timer); }
    let j = null;
    try { j = JSON.parse(text); } catch { /* 아래에서 처리 */ }
    if (res.status === 401 || res.status === 403) throw new UpstashError('auth', `Upstash 토큰 · 권한 오류(HTTP ${res.status}) — UPSTASH_REDIS_REST_TOKEN을 확인하세요`, res.status);
    if (!res.ok) {
      const kind = res.status === 429 ? 'quota' : /NOPERM|readonly/i.test(j?.error || '') ? 'auth' : res.status === 400 ? 'command' : 'server';
      throw new UpstashError(kind, `Upstash 오류(HTTP ${res.status}${j?.error ? `: ${redact(j.error).slice(0, 160)}` : ''})`, res.status);
    }
    if (j === null) throw new UpstashError('parse', 'Upstash 응답을 해석하지 못했어요');
    return j;
  }

  return {
    configured: Boolean(base && tok),
    /** 명령 하나 → result */
    async cmd(...args) {
      const j = await post('', args.map(String));
      if (j?.error) throw new UpstashError(/NOPERM|readonly/i.test(j.error) ? 'auth' : 'command', `Upstash 명령 오류: ${redact(j.error).slice(0, 160)}`);
      return j?.result;
    },
    /** 여러 명령을 한 번에(순서대로, 원자적이지 않음) → result 배열 */
    async pipeline(cmds) {
      const j = await post('/pipeline', cmds.map((c) => c.map(String)));
      if (!Array.isArray(j)) throw new UpstashError('parse', 'Upstash pipeline 응답 형식이 달라요');
      const bad = j.find((r) => r?.error);
      if (bad) throw new UpstashError('command', `Upstash 명령 오류: ${redact(bad.error).slice(0, 160)}`);
      return j.map((r) => r?.result);
    },
  };
}

/** HGETALL 결과(평평한 배열 [필드, 값, 필드, 값 …] 또는 객체) → { 필드: 값 } */
export function pairsToObject(result) {
  if (!result) return {};
  if (Array.isArray(result)) {
    const out = {};
    for (let i = 0; i + 1 < result.length; i += 2) out[String(result[i])] = result[i + 1];
    return out;
  }
  return typeof result === 'object' ? { ...result } : {};
}

/**
 * 사용자 기록 저장소(Upstash 해시 하나): 필드 = 사용자 ID, 값 = 사용자 기록 JSON
 * @param {ReturnType<typeof createUpstash>} client
 */
export function upstashUsers(client, key = 'kubusai:users') {
  return {
    kind: 'upstash',
    async loadAll() {
      const obj = pairsToObject(await client.cmd('HGETALL', key));
      const out = {};
      for (const [id, json] of Object.entries(obj)) {
        try { const u = typeof json === 'string' ? JSON.parse(json) : json; if (u && typeof u === 'object') out[id] = u; } catch { /* 깨진 값은 건너뜀 */ }
      }
      return out;
    },
    /** @param {Array<[string, object]>} entries */
    async saveMany(entries) {
      if (!entries.length) return;
      const args = ['HSET', key];
      for (const [id, u] of entries) args.push(id, JSON.stringify(u));
      await client.cmd(...args);
    },
    /** v2.2.4 사용자 기록 지우기(HDEL 한 번에 여럿) @param {string[]} ids */
    async deleteMany(ids) {
      if (!ids.length) return;
      await client.cmd('HDEL', key, ...ids);
    },
  };
}
