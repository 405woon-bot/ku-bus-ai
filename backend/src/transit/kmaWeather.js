// 기상청 단기예보 조회서비스 · 초단기실황조회(getUltraSrtNcst) → 국민대 격자의 지금 강수형태 · 1시간 강수량
//
//   요청: https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst
//         ?serviceKey=…&pageNo=1&numOfRows=20&dataType=JSON&base_date=YYYYMMDD&base_time=HH00&nx=60&ny=128
//   인증키: 공공데이터포털 일반 인증키(Encoding · Decoding 둘 다 가능) → 서버 환경변수 KMA_API_KEY에만 둡니다.
//   호출 아끼기: 결과를 10분(WEATHER_CACHE_SEC, 600~1800초)마다 한 번만 새로 받아 모든 요청이 나눠 씀 → 하루 최대 약 300회(한도 10,000).
//   실패: 90분 이내 직전 값(stale) → 그보다 오래되면 날씨를 빼고(error) 앱은 그대로. 실패 뒤 5분 · 호출 한도 초과 뒤 1시간은 다시 부르지 않음.
//   ※ 응답 형식 '확인 필요' — 실제 응답을 받기 전이라 JSON · XML · 공공데이터포털 오류 응답을 모두 받아 들이고,
//     예상과 다르면 날씨만 생략합니다(shared/weather.js의 summarizeNcst).
import { KU_GRID, ncstBase, prevBase, summarizeNcst } from '../../../shared/weather.js';
import { sampleNcstItems } from '../../../shared/samples/weatherSample.js';

export const DEFAULT_KMA_BASE_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';

export class WeatherApiError extends Error {
  constructor(kind, message) { super(message); this.name = 'WeatherApiError'; this.kind = kind; }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ENTITIES[e.toLowerCase()]));
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`).exec(xml); return m ? decode(m[1].trim()) : ''; };
function fields(xml) {
  const out = {};
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2] === undefined ? '' : decode(m[2].trim());
  return out;
}

const AUTH_CODES = ['20', '21', '30', '31', '32', '33'];
const AUTH_MSG = /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|TEMPORARILY_DISABLE|DEADLINE_HAS_EXPIRED|UNREGISTERED_IP|UNSIGNED_CALL/;
function checkCode(code, msg) {
  if (!code || code === '00' || code === '0') return;
  if (code === '03' || /NO_?DATA/i.test(msg)) throw new WeatherApiError('nodata', '기상청: 이 시각 자료가 아직 없어요');
  if (code === '22' || /LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(msg)) throw new WeatherApiError('quota', '기상청 API 일일 호출 한도를 넘었어요');
  if (AUTH_CODES.includes(code) || AUTH_MSG.test(msg)) throw new WeatherApiError('auth', `기상청 인증키 오류(${msg || code}) — 키 값 · 활용 신청 승인 · 기간을 확인하세요`);
  throw new WeatherApiError('api', `기상청 API 오류(${code}${msg ? ` ${msg}` : ''})`);
}

/**
 * 응답 본문 → { code, message, items } — JSON(dataType=JSON) · XML · 공공데이터포털 게이트웨이 오류(XML) 모두.
 * 형식이 예상과 다르면 WeatherApiError('parse').
 */
export function parseKmaResponse(text) {
  const s = String(text ?? '').trim();
  if (s.startsWith('{')) {
    let j;
    try { j = JSON.parse(s); } catch { throw new WeatherApiError('parse', '기상청 응답(JSON)을 해석하지 못했어요'); }
    const header = j?.response?.header;
    if (!header) throw new WeatherApiError('parse', '기상청 응답 형식이 예상과 달라요(response.header 없음)');
    const code = String(header.resultCode ?? '').trim(), message = String(header.resultMsg ?? '').trim();
    checkCode(code, message);
    let items = j?.response?.body?.items?.item ?? [];
    if (!Array.isArray(items)) items = items && typeof items === 'object' ? [items] : [];
    return { code, message, items };
  }
  if (s.startsWith('<')) {
    if (/<OpenAPI_ServiceResponse|<cmmMsgHeader/.test(s)) {
      const reason = tag(s, 'returnReasonCode'), auth = tag(s, 'returnAuthMsg');
      checkCode(reason || '99', auth || tag(s, 'errMsg'));
    }
    const code = tag(s, 'resultCode'), message = tag(s, 'resultMsg');
    if (!code && !/<items?\b/.test(s)) throw new WeatherApiError('parse', '기상청 응답(XML)을 해석하지 못했어요');
    checkCode(code, message);
    const items = [...s.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => fields(m[1]));
    return { code, message, items };
  }
  throw new WeatherApiError('parse', '기상청 응답을 해석하지 못했어요(JSON · XML이 아님)');
}

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} [o.env] KMA_API_KEY · WEATHER_CACHE_SEC(기본 600, 600~1800) · KMA_NX · KMA_NY · KMA_BASE_URL · KMA_TIMEOUT_MS
 * @param {Function} [o.fetchImpl]
 * @param {() => number} [o.clock]
 */
export function createWeatherService({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now(),
  staleMaxMs = 90 * 60_000, retryMs = 5 * 60_000, quotaCooldownMs = 60 * 60_000, waitMs = 2500 } = {}) {
  const raw = String(env.KMA_API_KEY || '').trim();
  const keyValue = raw && (/%[0-9A-Fa-f]{2}/.test(raw) ? raw : encodeURIComponent(raw)); // Encoding 키(%포함)는 그대로
  const cacheMs = Math.min(1800, Math.max(600, Number(env.WEATHER_CACHE_SEC) || 600)) * 1000;
  const base = String(env.KMA_BASE_URL || DEFAULT_KMA_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(env.KMA_TIMEOUT_MS) || 8000;
  const nx = Number.isInteger(Number(env.KMA_NX)) && env.KMA_NX ? Number(env.KMA_NX) : KU_GRID.nx;
  const ny = Number.isInteger(Number(env.KMA_NY)) && env.KMA_NY ? Number(env.KMA_NY) : KU_GRID.ny;
  const st = { last: null, lastError: null, calls: 0, inflight: null, until: 0 };
  const redact = (s) => (raw ? String(s).split(raw).join('[KEY]').split(keyValue).join('[KEY]') : String(s));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

  async function call({ baseDate, baseTime }) {
    const qs = new URLSearchParams({ pageNo: '1', numOfRows: '20', dataType: 'JSON', base_date: baseDate, base_time: baseTime, nx: String(nx), ny: String(ny) });
    const url = `${base}/getUltraSrtNcst?serviceKey=${keyValue}&${qs}`;
    st.calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new WeatherApiError('timeout', `기상청 API가 ${timeoutMs / 1000}초 안에 응답하지 않았어요`);
      throw new WeatherApiError('network', `기상청 API에 연결하지 못했어요(${redact(e.message)})`);
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      try { parseKmaResponse(text); } catch (e) { if (['auth', 'quota'].includes(e.kind)) throw e; }
      throw new WeatherApiError('http', `기상청 API가 HTTP ${res.status}로 응답했어요`);
    }
    return parseKmaResponse(text).items;
  }

  async function fetchNow() {
    const b = ncstBase(clock());
    let items;
    try { items = await call(b); } catch (e) {
      if (e.kind !== 'nodata') throw e;
      items = null;
    }
    if (!items?.length) items = await call(prevBase(b)); // 정시 자료가 아직 없으면(NODATA · 빈 목록) 한 시간 전
    const w = summarizeNcst(items);
    if (!w) throw new WeatherApiError('format', '기상청 응답에서 강수형태(PTY) · 1시간 강수량(RN1)을 찾지 못했어요(응답 형식 확인 필요)');
    return { at: clock(), w };
  }

  const usable = () => st.last && clock() - st.last.at <= staleMaxMs;
  async function load() {
    if (!raw) throw new WeatherApiError('no-key', '서버에 KMA_API_KEY가 없어요');
    if (st.last && clock() - st.last.at < cacheMs) return { ...st.last, stale: false };
    if (clock() >= st.until) {
      if (!st.inflight) {
        st.inflight = fetchNow()
          .then((v) => { st.last = v; st.lastError = null; st.until = 0; return v; })
          .catch((e) => {
            const err = e instanceof WeatherApiError ? e : new WeatherApiError('api', redact(e.message));
            st.lastError = { kind: err.kind, message: redact(err.message), at: clock() };
            st.until = clock() + (err.kind === 'quota' ? quotaCooldownMs : retryMs);
            throw err;
          })
          .finally(() => { st.inflight = null; });
        st.inflight.catch(() => {});
      }
      try { return { ...(await st.inflight), stale: false }; } catch (e) { if (!usable()) throw e; }
    }
    if (usable()) return { ...st.last, stale: true };
    throw new WeatherApiError(st.lastError?.kind || 'api', st.lastError?.message || '기상청 날씨를 받지 못했어요');
  }

  const view = (r) => {
    const { raw: _raw, ...w } = r.w;
    return { source: 'kma', ...w, grid: { nx, ny }, fetchedAt: iso(r.at), stale: Boolean(r.stale), ageSec: Math.round((clock() - r.at) / 1000) };
  };

  /**
   * 화면 · 설명용 지금 날씨. 오류가 나도 던지지 않고 source로 알려 줍니다(화면은 'kma' · 'mock'일 때만 날씨를 보여 줌).
   * @param {Date} nowDate
   * @param {{ example?: boolean }} [o] 기상청 키가 없고 버스도 예시 데이터일 때 true → 예시 날씨(source 'mock')
   * @returns {Promise<{ source:'kma'|'mock'|'off'|'error'|'loading', reason?, ... }>}
   */
  async function forView(nowDate = new Date(clock()), { example = false } = {}) {
    if (!raw) {
      if (!example) return { source: 'off', reason: 'no-key' };
      const { raw: _r, ...w } = summarizeNcst(sampleNcstItems(nowDate.getTime()));
      return { source: 'mock', reason: 'example', ...w, grid: { nx, ny } };
    }
    const TIMEOUT = Symbol('wait');
    const loading = load();
    loading.catch(() => {});
    try {
      const r = await Promise.race([loading, new Promise((resolve) => { setTimeout(() => resolve(TIMEOUT), waitMs).unref?.(); })]);
      if (r !== TIMEOUT) return view(r);
      return usable() ? view({ ...st.last, stale: true }) : { source: 'loading', reason: 'loading' };
    } catch (e) {
      return { source: 'error', reason: e.kind || 'api', message: redact(e.message) };
    }
  }

  /** 확인용(/api/weather): 화면용 값 + 받은 항목 원문(raw) — 응답 형식을 눈으로 확인할 때 */
  async function inspect(nowDate = new Date(clock())) {
    const v = await forView(nowDate);
    return v.source === 'kma' ? { ...v, raw: st.last?.w?.raw ?? null, formatVerified: false } : { ...v, grid: { nx, ny }, formatVerified: false };
  }

  return {
    forView,
    inspect,
    load,
    health() {
      return {
        keyConfigured: Boolean(raw), grid: { nx, ny }, cacheSec: cacheMs / 1000, lastOkAt: iso(st.last?.at),
        lastObs: st.last ? `${st.last.w.baseDate} ${st.last.w.baseTime}` : null, wet: st.last?.w?.wet ?? null,
        lastError: st.lastError && { ...st.lastError, at: iso(st.lastError.at) }, retryAfter: st.until > clock() ? iso(st.until) : null,
        calls: st.calls, formatVerified: false,
      };
    },
  };
}
