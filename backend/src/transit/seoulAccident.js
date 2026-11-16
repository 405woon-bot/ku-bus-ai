// 서울시 실시간 돌발정보(서울 열린데이터광장 OA-13315, 서비스 AccInfo) → 통학 경로 주변 돌발정보
//
//   요청: http://openapi.seoul.go.kr:8088/{인증키}/xml/AccInfo/{시작}/{끝}/   — 돌발정보는 XML만 지원(JSON 없음)
//   인증키: 서울 열린데이터광장에서 따로 받은 키(버스 API 키와 다름) → 서버 환경변수 SEOUL_ACCIDENT_API_KEY에만 둡니다.
//   호출 아끼기: 서울 전체 목록을 5분(ACCIDENT_CACHE_SEC)에 한 번만 받아 메모리에 두고 모든 요청이 나눠 씁니다.
//   실패하면 15분 이내 직전 값(stale) → 그보다 오래되면 빈 목록 + 이유. 실패 뒤 1분은 다시 부르지 않습니다.
import { matchIncidents, normalizeAcc } from '../../../shared/incidents.js';
import { sampleIncidentRows } from '../../../shared/samples/incidentSample.js';

export const DEFAULT_ACC_BASE_URL = 'http://openapi.seoul.go.kr:8088';

export class AccidentApiError extends Error {
  constructor(kind, message) { super(message); this.name = 'AccidentApiError'; this.kind = kind; }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ENTITIES[e.toLowerCase()]));
function fields(xml) {
  const out = {};
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2] === undefined ? '' : decode(m[2].trim());
  return out;
}

/**
 * AccInfo XML → { code, message, total, rows }
 *   INFO-000 정상 · INFO-200 해당 데이터 없음(빈 목록) · INFO-100/300 인증키 문제 · ERROR-xxx 요청 · 서버 오류
 */
export function parseAccInfoXml(text) {
  const s = String(text ?? '');
  if (!/<\s*(AccInfo|RESULT)\b/.test(s)) throw new AccidentApiError('parse', '서울시 돌발정보 응답을 해석하지 못했어요');
  const code = (/<CODE>\s*([^<]*?)\s*<\/CODE>/.exec(s)?.[1] || '').trim();
  const message = decode((/<MESSAGE>\s*([\s\S]*?)\s*<\/MESSAGE>/.exec(s)?.[1] || '').trim());
  if (code === 'INFO-200') return { code, message, total: 0, rows: [] };
  if (code === 'INFO-100' || code === 'INFO-300') throw new AccidentApiError('auth', `돌발정보 인증키 오류(${code}) — 열린데이터광장 인증키를 확인하세요`);
  if (code && code !== 'INFO-000') throw new AccidentApiError('api', `서울시 돌발정보 오류(${code}${message ? ` ${message}` : ''})`);
  const rows = [...s.matchAll(/<row>([\s\S]*?)<\/row>/g)].map((m) => fields(m[1]));
  const total = Number(/<list_total_count>\s*(\d+)\s*<\/list_total_count>/.exec(s)?.[1]) || rows.length;
  return { code: code || 'INFO-000', message, total, rows };
}

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} [o.env] SEOUL_ACCIDENT_API_KEY · ACCIDENT_CACHE_SEC(기본 300, 최소 60) · SEOUL_ACCIDENT_BASE_URL · SEOUL_ACCIDENT_TIMEOUT_MS
 * @param {Function} [o.fetchImpl] 테스트에서 응답을 바꿔 끼움
 * @param {() => number} [o.clock]
 * @param {number} [o.waitMs=2500] 화면 요청이 첫 응답을 기다리는 최대 시간(넘으면 이번에는 빈 목록, 다음 요청에 반영)
 */
export function createAccidentService({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now(),
  staleMaxMs = 15 * 60_000, retryMs = 60_000, waitMs = 2500 } = {}) {
  const key = String(env.SEOUL_ACCIDENT_API_KEY || '').trim();
  const cacheMs = Math.max(60, Number(env.ACCIDENT_CACHE_SEC) || 300) * 1000;
  const base = String(env.SEOUL_ACCIDENT_BASE_URL || DEFAULT_ACC_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(env.SEOUL_ACCIDENT_TIMEOUT_MS) || 8000;
  const st = { last: null, lastError: null, calls: 0, inflight: null };
  const redact = (s) => (key ? String(s).split(key).join('[KEY]').split(encodeURIComponent(key)).join('[KEY]') : String(s));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

  async function page(from, to) {
    const url = `${base}/${encodeURIComponent(key)}/xml/AccInfo/${from}/${to}/`;
    st.calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new AccidentApiError('timeout', `서울시 돌발정보가 ${timeoutMs / 1000}초 안에 응답하지 않았어요`);
      throw new AccidentApiError('network', `서울시 돌발정보에 연결하지 못했어요(${redact(e.message)})`);
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new AccidentApiError('http', `서울시 돌발정보가 HTTP ${res.status}로 응답했어요`);
    return parseAccInfoXml(text);
  }

  async function fetchAll() {
    const first = await page(1, 1000);
    let rows = first.rows;
    for (let from = 1001; from <= Math.min(first.total, 3000); from += 1000) rows = rows.concat((await page(from, from + 999)).rows);
    return { at: clock(), total: first.total, items: rows.map(normalizeAcc).filter(Boolean) };
  }

  const usable = () => st.last && clock() - st.last.at <= staleMaxMs;
  /** 서울 전체 돌발정보(보여 줄 종류만). 캐시 → 새로 받기 → 직전 값 순 */
  async function load() {
    if (!key) throw new AccidentApiError('no-key', '서버에 SEOUL_ACCIDENT_API_KEY가 없어요');
    if (st.last && clock() - st.last.at < cacheMs) return { ...st.last, stale: false };
    if (!(st.lastError && clock() - st.lastError.at < retryMs)) {
      if (!st.inflight) {
        st.inflight = fetchAll()
          .then((v) => { st.last = v; st.lastError = null; return v; })
          .catch((e) => {
            const err = e instanceof AccidentApiError ? e : new AccidentApiError('api', redact(e.message));
            st.lastError = { kind: err.kind, message: err.message, at: clock() };
            throw err;
          })
          .finally(() => { st.inflight = null; });
        st.inflight.catch(() => {}); // 기다리던 요청이 시간 초과로 먼저 끝나도 처리되지 않은 거부가 남지 않게
      }
      try { return { ...(await st.inflight), stale: false }; } catch (e) { if (!usable()) throw e; }
    }
    if (usable()) return { ...st.last, stale: true };
    throw new AccidentApiError(st.lastError?.kind || 'api', st.lastError?.message || '서울시 돌발정보를 받지 못했어요');
  }

  /**
   * 탑승 정류장 노선들(trips: path 포함) 주변 돌발정보. 오류가 나도 던지지 않고 이유를 담아 돌려줍니다.
   * @param {Array} trips
   * @param {Date} nowDate
   * @param {{ example?: boolean }} [o] 버스가 예시 데이터일 때 true → 예시 돌발정보 1건(source 'mock')
   * @returns {Promise<{ source:'seoul'|'mock'|'off'|'error'|'loading', reason, items, fetchedAt?, stale?, ageSec?, message? }>}
   */
  async function forTrips(trips, nowDate = new Date(clock()), { example = false } = {}) {
    const nowMs = nowDate.getTime();
    if (example) {
      const items = matchIncidents(sampleIncidentRows(nowMs).map(normalizeAcc).filter(Boolean), { trips, nowMs }).slice(0, 1);
      return { source: 'mock', reason: 'example', items };
    }
    if (!key) return { source: 'off', reason: 'no-key', items: [] };
    const TIMEOUT = Symbol('wait');
    const loading = load();
    loading.catch(() => {}); // 기다림이 먼저 끝난 뒤 실패해도 처리되지 않은 거부가 남지 않게
    try {
      const r = await Promise.race([loading, new Promise((resolve) => { setTimeout(() => resolve(TIMEOUT), waitMs).unref?.(); })]);
      if (r === TIMEOUT) {
        if (usable()) return { source: 'seoul', reason: null, items: matchIncidents(st.last.items, { trips, nowMs }), fetchedAt: iso(st.last.at), stale: true, ageSec: Math.round((clock() - st.last.at) / 1000) };
        return { source: 'loading', reason: 'loading', items: [] };
      }
      return { source: 'seoul', reason: null, items: matchIncidents(r.items, { trips, nowMs }), fetchedAt: iso(r.at), stale: r.stale, ageSec: Math.round((clock() - r.at) / 1000) };
    } catch (e) {
      return { source: 'error', reason: e.kind || 'api', message: redact(e.message), items: [] };
    }
  }

  return {
    forTrips,
    load,
    health() {
      return {
        keyConfigured: Boolean(key), cacheSec: cacheMs / 1000, lastOkAt: iso(st.last?.at), total: st.last?.total ?? null,
        shown: st.last?.items.length ?? null, lastError: st.lastError && { ...st.lastError, at: iso(st.lastError.at) }, calls: st.calls,
      };
    },
  };
}
