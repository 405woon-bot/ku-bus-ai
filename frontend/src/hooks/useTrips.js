import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { sampleTrips } from '@source';

const REFRESH_MS = 20000;

/** 미리보기에서 고르는 배지 상태 — 실제 서비스는 서버 응답의 source·reason·stale을 그대로 씁니다. */
export const PREVIEW_SOURCES = {
  live: { label: '실시간 연결', source: 'seoul' },
  stale: { label: '잠시 끊김', source: 'seoul', stale: true, ageSec: 75 },
  fallback: { label: '실시간 실패', source: 'mock', reason: 'quota' },
};

/**
 * 탑승 정류장 → 국민대행 노선별 실시간 도착·차내 시간·정체.
 * api: 20초마다 /api/stops/:arsId/trips. 그 사이에는 받은 뒤 흐른 시간만큼 도착 예정을 줄여 카운트다운.
 *      서버가 서울시 API를 못 쓰면 직전 값(stale) 또는 예시 데이터(source 'mock' + reason)를 보내 줍니다.
 * sample: 샘플 응답 재생(미리보기). previewSource로 배지 상태만 바꿔 볼 수 있습니다.
 * @returns {{ status:'idle'|'loading'|'ok'|'stale'|'error', trips, source?, reason?, stale?, ageSec?, at?, fetchedMin?, error? }}
 */
export function useTrips({ mode, stop, now, previewSource = 'live' }) {
  const sampleKey = mode === 'sample' ? Math.floor((now.elapsedSec || 0) / 5) : 0;
  const sample = useMemo(() => {
    if (mode !== 'sample' || !stop) return null;
    const { label, ...src } = PREVIEW_SOURCES[previewSource] || PREVIEW_SOURCES.live;
    return { status: 'ok', trips: sampleTrips(stop.arsId, now.elapsedSec || 0), fetchedMin: now.minutes, preview: true, ...src };
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [mode, stop?.arsId, sampleKey, previewSource]);

  const [live, setLive] = useState({ status: 'idle', trips: [] });
  useEffect(() => {
    if (mode !== 'api' || !stop) return undefined;
    let alive = true;
    setLive((l) => ({ ...l, status: l.trips.length ? l.status : 'loading' }));
    const load = async () => {
      try {
        const j = await api.trips(stop.arsId);
        if (alive) {
          setLive({ status: 'ok', trips: j.trips || [], at: Date.now(), fetchedMin: now.minutes,
            source: j.source || 'seoul', reason: j.reason || null, stale: Boolean(j.stale), ageSec: j.ageSec || 0 });
        }
      } catch (e) { if (alive) setLive((l) => ({ ...l, status: l.trips.length ? 'stale' : 'error', error: e.message })); }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, stop?.arsId]);

  const tick = Math.floor(Date.now() / 5000);
  const adjusted = useMemo(() => {
    if (mode !== 'api' || !live.at) return live;
    const shift = (Date.now() - live.at) / 1000; // 받은 뒤 흐른 초
    return { ...live, trips: live.trips.map((t) => ({ ...t, etasSec: t.etasSec.map((s) => s - shift).filter((s) => s > -20) })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, live, tick]);
  if (!stop) return { status: 'idle', trips: [] };
  return mode === 'sample' ? sample : adjusted;
}
