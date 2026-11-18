// 작은 키-값 저장소: 외부 DB(Upstash Redis, 서버가 잠들거나 다시 배포돼도 남음) 또는 메모리(로컬 개발 · 테스트).
//   ODsay 경로 검색 결과(30일 새것 · 90일 보관) · 하루 호출 수(ODsay 25건 · 실시간 지하철 900건 상한)를 담습니다.
import { createUpstash, pairsToObject } from '../upstash.js';

/**
 * @param {{ upstash?: ReturnType<typeof createUpstash>|null, clock?: () => number }} o
 * @returns {{ kind, get(k), set(k, v, ttlSec?), expire(k, ttlSec), incr(k, ttlSec), getNum(k), hgetall(k), hset(k, f, v), hdel(k, f) }}
 */
export function createKv({ upstash = null, clock = () => Date.now() } = {}) {
  if (upstash?.configured) {
    return {
      kind: 'upstash',
      async get(k) { return (await upstash.cmd('GET', k)) ?? null; },
      async set(k, v, ttlSec) { await upstash.cmd('SET', k, v, ...(ttlSec ? ['EX', ttlSec] : [])); },
      /** 남은 보관 시간 바꾸기(v2.1: 예전 검색 결과를 90일까지 남김) */
      async expire(k, ttlSec) { return Number(await upstash.cmd('EXPIRE', k, ttlSec)) || 0; },
      /** 1 늘리고 새 값(만료 시간도 새로) */
      async incr(k, ttlSec) { const [n] = await upstash.pipeline([['INCR', k], ['EXPIRE', k, ttlSec]]); return Number(n) || 0; },
      async getNum(k) { return Number(await upstash.cmd('GET', k)) || 0; },
      async hgetall(k) { return pairsToObject(await upstash.cmd('HGETALL', k)); },
      async hset(k, f, v) { await upstash.cmd('HSET', k, f, v); },
      async hdel(k, f) { await upstash.cmd('HDEL', k, f); },
    };
  }
  const m = new Map(); // 키 → { v | h, exp }
  const live = (k) => { const e = m.get(k); if (e && e.exp && e.exp <= clock()) { m.delete(k); return null; } return e || null; };
  const exp = (ttlSec) => (ttlSec ? clock() + ttlSec * 1000 : 0);
  return {
    kind: 'memory',
    async get(k) { return live(k)?.v ?? null; },
    async set(k, v, ttlSec) { m.set(k, { v: String(v), exp: exp(ttlSec) }); },
    async expire(k, ttlSec) { const e = live(k); if (!e) return 0; e.exp = exp(ttlSec); return 1; },
    async incr(k, ttlSec) { const n = (Number(live(k)?.v) || 0) + 1; m.set(k, { v: String(n), exp: exp(ttlSec) }); return n; },
    async getNum(k) { return Number(live(k)?.v) || 0; },
    async hgetall(k) { return { ...(live(k)?.h || {}) }; },
    async hset(k, f, v) { const e = live(k) || { h: {}, exp: 0 }; e.h = { ...(e.h || {}), [f]: String(v) }; m.set(k, e); },
    async hdel(k, f) { const e = live(k); if (e?.h) delete e.h[f]; },
  };
}

/** 환경변수에 Upstash 주소 · 토큰이 있으면 외부 DB, 없으면 메모리 */
export function createKvFromEnv(env = process.env, { fetchImpl, clock } = {}) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').trim(), token = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  const upstash = url && token ? createUpstash({ url, token, ...(fetchImpl ? { fetchImpl } : {}) }) : null;
  return createKv({ upstash, ...(clock ? { clock } : {}) });
}
