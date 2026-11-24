// v2.1 환승 경로를 못 찾을 때(한도 초과 · 키 없음 · 경로 없음 · ODsay 오류): 출발지 근처(기본 400m)의 '국민대로 바로 가는' 정류장 찾기
//   · 서울시 정류소정보 getStationByPos(내 주변 정류장, 가까운 순) → 가까운 정류장부터 stopTrips(도착 정보 + 경유 정류소)로
//     국민대 정문 · 후문 정류장을 지나는 노선이 있는지 확인(기존 직행 계산과 같은 판단)
//   · 서울시 호출을 아끼려고 같은 자리(약 100m 칸)는 6시간 기억 · 정류장 하나씩 차례로 확인
//   · v2.3: 정류장 확인이 일시적으로 실패한 결과(못 받음 · 시간 초과 등)는 6시간 기억하지 않음 — 1분만 기억(연타 방지)하고,
//     하나도 확인하지 못했으면 '정류장이 없어요'가 아니라 '확인하지 못했어요'로 알림(없다고 지어내지 않음)
//   · 실시간을 받지 못한 정류장(예시 데이터로 대신한 응답)은 '모름'으로 보고 건너뜀 — 국민대행이라고 지어내지 않음
//   · v2.2.6: 확인하는 정류장 4곳 → 6곳(가까운 순). 화면에는 원래도 3곳까지만이라, 국민대행 3곳을 찾으면 더 부르지 않음
//   · v2.2.6: 심야(서울 23:00 ~ 04:30 전)에 정류장을 확인했는데 국민대행을 하나도 못 찾았으면 night 표시 —
//     막차 뒤에는 도착 정보가 비어 있을 수 있어 '없다'고 단정하지 않음. 이 결과는 6시간이 아니라 1분만 기억(아침에 다시 확인)
import { TRANSIT, distanceM, isLateNight } from '../../../shared/transitPlan.js';
import { seoulParts } from '../../../shared/time.js';

const WALK_M_PER_MIN = 70;          // 걸어서 1분에 70m(보수적으로)
export const WALK_CHOICES = [3, 5, 10, 15]; // 설정 '정류장까지 걸어서' 고르기 값
/** 걸어서 걸리는 분 → 설정 칩 값(같거나 큰 것 중 가장 작은 값, 넘으면 15) */
export const walkChip = (min) => WALK_CHOICES.find((c) => c >= min) ?? WALK_CHOICES[WALK_CHOICES.length - 1];
/** 화면에 보여 주는 근처 국민대행 정류장 수(가까운 순) */
export const SHOW_STOPS = 3;

/**
 * @param {{ provider, clock?, radiusM?, maxStops?, ttlMs?, failTtlMs? }} o  provider = createLiveService()(nearStops · stopTrips)
 */
export function createNearKuFinder({ provider, clock = () => Date.now(), radiusM = TRANSIT.nearKuRadiusM, maxStops = 6, ttlMs = 6 * 3600_000, failTtlMs = 60_000 } = {}) {
  const memo = new Map(); // '위도,경도'(소수 셋째 자리) → { at, result, ttl }
  const stats = { finds: 0, memoHits: 0, partial: 0, night: 0, lastError: null };

  /**
   * @returns {Promise<{ ok: boolean, stops: Array<{ arsId, name, lat, lon, distM, walkMin, walkChip, routes: string[] }>, reason?: string, radiusM?: number, night?: true }>}
   */
  async function find(lat, lon) {
    if (!(Number(lat) >= 33 && Number(lat) <= 39 && Number(lon) >= 124 && Number(lon) <= 132)) return { ok: false, reason: 'bad', stops: [] };
    const k = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
    const m = memo.get(k);
    if (m && clock() - m.at < m.ttl) { stats.memoHits++; return m.result; }
    stats.finds++;
    let near;
    try { near = await provider.nearStops(Number(lat), Number(lon), radiusM); } catch (e) {
      stats.lastError = { kind: e?.kind || 'api', message: String(e?.message || e).slice(0, 120), at: clock() };
      return { ok: false, reason: e?.kind || 'api', stops: [] };
    }
    const here = { x: Number(lon), y: Number(lat) };
    const cands = (near || []).filter((s) => /^\d{5}$/.test(String(s.arsId))).slice(0, maxStops);
    const out = [];
    let stopReason = null;
    let unchecked = 0; // 일시적으로 확인하지 못한 정류장 수(없다는 뜻이 아님)
    for (const s of cands) {
      if (out.length >= SHOW_STOPS) break; // 가까운 순이라 이미 찾은 3곳이 화면에 나갈 곳 — 더 부르지 않음
      let r;
      try { r = await provider.stopTrips(s.arsId, new Date(clock())); } catch (e) { unchecked++; stats.lastError = { kind: e?.kind || 'api', message: String(e?.message || e).slice(0, 120), at: clock() }; continue; }
      if (r?.source !== 'seoul') { if (['quota', 'no-key', 'auth'].includes(r?.reason)) { stopReason = r.reason; break; } unchecked++; continue; }
      const routes = [...new Set((r.trips || []).map((t) => String(t.no)).filter(Boolean))];
      if (!routes.length) continue;
      const distM = Math.round(Number.isFinite(s.distM) ? s.distM : Number.isFinite(s.lat) ? distanceM(here, { x: s.lon, y: s.lat }) : radiusM);
      const walkMin = Math.max(1, Math.ceil(distM / WALK_M_PER_MIN));
      out.push({ arsId: String(s.arsId), name: s.name, lat: s.lat ?? null, lon: s.lon ?? null, distM, walkMin, walkChip: walkChip(walkMin), routes: routes.slice(0, 4) });
    }
    out.sort((a, b) => a.distM - b.distM);
    // 심야: 정류장을 확인했는데(키 · 한도 문제 아님) 국민대행을 하나도 못 찾음 → '없음'이라고 단정하지 않게 표시
    const night = !stopReason && !out.length && cands.length > 0 && isLateNight(seoulParts(new Date(clock())).minutes);
    const nightMark = night ? { night: true } : {};
    // 하나도 찾지 못했는데 확인 못 한 정류장이 있으면 '없음'이 아니라 '확인 못 함'
    const result = stopReason && !out.length ? { ok: false, reason: stopReason, stops: [] }
      : unchecked && !out.length ? { ok: false, reason: 'api', stops: [], ...nightMark }
        : { ok: true, stops: out.slice(0, SHOW_STOPS), radiusM, ...nightMark };
    if (unchecked) stats.partial++;
    if (night) stats.night++;
    if (!stopReason) memo.set(k, { at: clock(), result, ttl: unchecked > 0 || night ? failTtlMs : ttlMs });
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    return result;
  }

  return {
    find,
    health() { return { radiusM, maxStops, show: SHOW_STOPS, finds: stats.finds, memoHits: stats.memoHits, partial: stats.partial, night: stats.night, lastError: stats.lastError && { ...stats.lastError, at: new Date(stats.lastError.at).toISOString() } }; },
  };
}
