// 서울시 API 응답 캐시(기본 30초). 메모리가 기본이고, REDIS_URL이 있으면 Redis를 씁니다(여러 서버가 같은 캐시를 공유).
// Redis는 선택 기능이라 package.json에 넣지 않았습니다 — 쓰려면 backend에서 `npm i redis` 후 REDIS_URL을 설정하세요.
//   인터페이스: get(key) → { value, at } | null,  set(key, value, ttlMs)

export function createMemoryCache({ max = 2000, clock = () => Date.now() } = {}) {
  const m = new Map();
  return {
    kind: 'memory',
    async get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (clock() >= e.exp) { m.delete(key); return null; }
      return { value: e.value, at: e.at };
    },
    async set(key, value, ttlMs) {
      m.delete(key);
      m.set(key, { value, at: clock(), exp: clock() + ttlMs });
      if (m.size > max) m.delete(m.keys().next().value); // 오래된 것부터 정리
    },
    get size() { return m.size; },
  };
}

/** node-redis(v4+) 클라이언트처럼 get/set(PX)을 가진 객체로 캐시 만들기 — 테스트에서는 가짜 클라이언트를 넣습니다. */
export function createRedisCache(client, { prefix = 'kubusai:' } = {}) {
  return {
    kind: 'redis',
    async get(key) {
      const raw = await client.get(prefix + key);
      if (!raw) return null;
      try { const e = JSON.parse(raw); return { value: e.value, at: e.at }; } catch { return null; }
    },
    async set(key, value, ttlMs) {
      await client.set(prefix + key, JSON.stringify({ value, at: Date.now() }), { PX: Math.max(1, Math.round(ttlMs)) });
    },
  };
}

/** 환경변수로 캐시 고르기. Redis 연결에 실패하면 메모리 캐시로 계속 동작합니다. */
export async function createCacheFromEnv(env = process.env, log = console) {
  if (!env.REDIS_URL) return createMemoryCache();
  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: env.REDIS_URL });
    client.on?.('error', (e) => log.warn?.(`[cache] Redis 오류: ${e.message}`));
    await client.connect();
    log.info?.('[cache] Redis 캐시 사용');
    return createRedisCache(client);
  } catch (e) {
    log.warn?.(`[cache] Redis를 쓸 수 없어 메모리 캐시로 동작합니다(${e.message})`);
    return createMemoryCache();
  }
}
