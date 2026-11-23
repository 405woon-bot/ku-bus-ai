import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { sampleTransitLive } from '@source';

const REFRESH_MS = 30000;
/** 받은 뒤 흐른 초만큼 도착 예정을 줄임(카운트다운) */
function shift(live, sec) {
  if (!live || !sec) return live;
  const s = (a) => (a || []).map((v) => v - sec).filter((v) => v > -30);
  return {
    ...live,
    first: live.first && { ...live.first, trains: (live.first.trains || []).map((t) => ({ ...t, etaSec: t.etaSec - sec })).filter((t) => t.etaSec > -30), buses: (live.first.buses || []).map((b) => ({ ...b, etasSec: s(b.etasSec) })) },
    final: live.final && { ...live.final, trips: (live.final.trips || []).map((t) => ({ ...t, etasSec: s(t.etasSec) })) },
  };
}

/**
 * 저장한 환승 경로의 실시간 재료(첫 지하철 · 버스, 마지막 국민대행 버스)
 *   api: 30초마다 /api/transit/live — 지하철 실시간은 서버가 출발 30분 전부터만 받아 옴(하루 한도 아끼기)
 *   sample: 예시 응답(실시간 아님)
 * @returns {{ status:'idle'|'loading'|'ok'|'error', rt, fetchedAt?, sample?, error? }}  rt는 지금 기준으로 맞춘 도착 예정
 */
export function useTransitLive({ mode, route, now, cls, walkTable, marginMin, personalOffsetMin, departedMin = null, preview = null }) {
  const key = route ? route.title + route.legs.length : '';
  const bucket = Math.floor(now.minutes * 12); // 시계 5초마다(미리보기 '시각 이동'도 바로 반영)
  const pv = preview || {};
  // v2.2 미리보기: '출발했어요!'를 눌렀으면 그 출발 시각 기준으로 첫 지하철 실시간 시간대를 정함(실서비스는 서버가 저장한 기록으로)
  const sample = useMemo(() => (mode === 'sample' && route ? sampleTransitLive(route, now, { cls, walkTable, marginMin, personalOffsetMin, preview: pv, departedMin }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, key, bucket, cls?.id, marginMin, personalOffsetMin, departedMin, pv.incidents, pv.weather, pv.explain]);
  const [live, setLive] = useState({ status: 'idle', rt: null });
  useEffect(() => {
    if (mode !== 'api' || !route) { setLive({ status: 'idle', rt: null }); return undefined; }
    let alive = true;
    setLive((l) => ({ ...l, status: l.rt ? l.status : 'loading' }));
    const load = () => api.transitLive().then((j) => { if (alive) setLive({ status: 'ok', rt: j, at: Date.now() }); })
      .catch((e) => { if (alive) setLive((l) => ({ ...l, status: l.rt ? 'stale' : 'error', error: e.message })); });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, key]);
  const tick = Math.floor(Date.now() / 5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const adjusted = useMemo(() => (live.at ? { ...live, rt: shift(live.rt, (Date.now() - live.at) / 1000) } : live), [live, tick]);
  if (!route) return { status: 'idle', rt: null };
  return mode === 'sample' ? { status: 'ok', rt: sample, sample: true } : adjusted;
}
