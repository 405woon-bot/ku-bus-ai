// v2.1 자주 쓰는 출발지 미리 찾아 두기(ODsay) — 그날 버려질 남은 한도로 주요 환승역 경로를 밤에 찾아 30일 저장
//   · 언제: ODSAY_WARM_HOURS(기본 21:00-21:40, 서울 시각) — cron-job.org가 서버를 깨워 두는 시간 안
//   · 얼마나: 오늘 남은 새 호출이 ODSAY_WARM_RESERVE(기본 3)회 이하가 되면 멈춤(늦게 찾는 사용자 몫) · 스케줄러 1분에 하나씩
//   · 무엇을: ODSAY_WARM_ORIGINS(쉼표로 구분, 비우면 shared/warmOrigins.js 기본 46곳, 'off'면 끔) 중
//     아직 저장 안 됐거나 7일 안에 '새 결과' 기한이 끝나는 곳부터. '경로 없음'으로 기억한 곳은 건너뜀
//   · 좌표: 사용자 검색과 같은 서울시 정류장 이름 검색(같은 이름 → 그 이름으로 시작하는 정류장) → 같은 이름이면 사용자 검색이 바로 맞물림
//   · 키는 서버 환경변수의 ODsay 키를 그대로(odsay.search) — 이 파일에는 키가 없음
import { seoulParts } from '../../../shared/time.js';
import { WARM_ORIGINS } from '../../../shared/warmOrigins.js';

const DAY_MS = 86400_000;
const REFRESH_BEFORE_MS = 7 * DAY_MS;
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** 'HH:MM-HH:MM' → [시작 분, 끝 분]. 형식이 틀리면 기본 21:00-21:40 */
export function parseWarmHours(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''));
  if (m) {
    const a = Number(m[1]) * 60 + Number(m[2]), b = Number(m[3]) * 60 + Number(m[4]);
    if (a >= 0 && b <= 24 * 60 && b > a) return [a, b];
  }
  return [21 * 60, 21 * 60 + 40];
}
/** 환경변수 → 미리 찾을 이름 목록(최대 100곳). 비우면 기본 목록, 'off'면 없음 */
export function warmListFromEnv(env = process.env) {
  const raw = String(env.ODSAY_WARM_ORIGINS || '').trim();
  if (/^off$/i.test(raw)) return [];
  if (!raw) return [...WARM_ORIGINS];
  return [...new Set(raw.split(/[,\n]/).map((s) => s.trim().slice(0, 30)).filter(Boolean))].slice(0, 100);
}

/**
 * @param {{ env?, odsay, provider, clock?, log? }} o  odsay = createOdsayService() · provider = createLiveService()(searchStops)
 */
export function createOdsayWarmer({ env = process.env, odsay, provider, clock = () => Date.now(), log = console } = {}) {
  const list = warmListFromEnv(env);
  const reserve = Math.max(0, Math.min(30, Number.isFinite(Number(env.ODSAY_WARM_RESERVE)) && String(env.ODSAY_WARM_RESERVE ?? '').trim() !== '' ? Number(env.ODSAY_WARM_RESERVE) : 3));
  const [from, to] = parseWarmHours(env.ODSAY_WARM_HOURS);
  const st = { running: false, date: null, tried: new Set(), unresolved: new Set(), lastRunAt: null, last: null, lastSkip: null, ready: null, warmedToday: 0 };
  const enabled = () => Boolean(odsay?.keyConfigured) && list.length > 0 && typeof provider?.searchStops === 'function';

  /** 사용자 검색과 같은 서울시 정류장 이름 검색 → 같은 이름의 정류장(없으면 그 이름으로 시작하는 정류장) */
  async function resolve(name) {
    const stops = await provider.searchStops(name);
    const ok = (s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.lat !== 0;
    return stops.find((s) => s.name === name && ok(s)) || stops.find((s) => s.name.startsWith(name) && ok(s)) || null;
  }
  /** 목록 중 '새 결과'가 7일 넘게 남았거나 '경로 없음'으로 기억한 곳 수 */
  async function countReady() {
    let n = 0;
    for (const name of list) { const f = await odsay.freshness(name); if (f.empty || f.until - clock() > REFRESH_BEFORE_MS) n++; }
    return n;
  }

  /** 스케줄러가 1분마다 부름: 시간 안이고 한도가 남았으면 한 곳만 찾음 */
  async function step(nowDate = new Date(clock())) {
    if (!enabled() || st.running) return null;
    const p = seoulParts(nowDate);
    if (st.date !== p.dateKey) { st.date = p.dateKey; st.tried = new Set(); st.warmedToday = 0; }
    if (p.minutes < from || p.minutes >= to) return null;
    st.running = true;
    try {
      st.lastRunAt = clock();
      const used = await odsay.usedToday();
      if (odsay.cap - used <= reserve) { st.lastSkip = 'reserve'; st.ready = await countReady(); return { skipped: 'reserve' }; }
      for (const name of list) {
        if (st.tried.has(name)) continue;
        const f = await odsay.freshness(name);
        if (f.empty || f.until - clock() > REFRESH_BEFORE_MS) continue;
        st.tried.add(name); // 하루에 한 번만 시도(실패해도 다음 이름으로)
        let stop = null;
        try { stop = await resolve(name); } catch (e) {
          st.last = { name, result: 'resolve-error', message: String(e?.message || e).slice(0, 120), at: clock() };
          if (['quota', 'no-key', 'auth'].includes(e?.kind)) return st.last; // 서울시 키 · 한도 문제면 오늘은 그만
          continue;
        }
        if (!stop) { st.unresolved.add(name); st.last = { name, result: 'unresolved', at: clock() }; continue; }
        st.unresolved.delete(name);
        const r = await odsay.search({ lat: stop.lat, lon: stop.lon, name, kind: 'stop', arsId: stop.arsId });
        st.last = { name, result: r.ok ? (r.cached ? 'cached' : 'warmed') : r.reason, at: clock() };
        if (r.ok && !r.cached) st.warmedToday++;
        st.ready = await countReady();
        return st.last;
      }
      st.lastSkip = 'done'; st.ready = await countReady();
      return { skipped: 'done' };
    } catch (e) {
      st.last = { result: 'error', message: String(e?.message || e).slice(0, 120), at: clock() };
      log.warn?.(`[odsay-warm] ${st.last.message}`);
      return st.last;
    } finally { st.running = false; }
  }

  return {
    step,
    list,
    health() {
      const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
      return {
        enabled: enabled(), list: list.length, ready: st.ready, reserve, hours: `${hhmm(from)}-${hhmm(to)}`, warmedToday: st.warmedToday,
        lastRunAt: iso(st.lastRunAt), last: st.last && { ...st.last, at: iso(st.last.at) }, lastSkip: st.lastSkip, unresolved: [...st.unresolved].slice(0, 20),
      };
    },
  };
}
