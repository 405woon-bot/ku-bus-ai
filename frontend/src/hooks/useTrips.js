import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { sampleExplain, sampleIncidents, sampleTrips, sampleWeather } from '@source';

const REFRESH_MS = 20000;
// 서버가 AI 문장을 기다리는 중(explain.pending)이면 이만큼 뒤 한 번 더 받음(서버 캐시에 담긴 AI 문장이 옴), 연속 최대 2번
const PENDING_RETRY_MS = 4000;

/** 미리보기에서 고르는 배지 상태 — 실제 서비스는 서버 응답의 source·reason·stale을 그대로 씁니다. */
export const PREVIEW_SOURCES = {
  live: { label: '실시간 연결', source: 'seoul' },
  stale: { label: '잠시 끊김', source: 'seoul', stale: true, ageSec: 75 },
  fallback: { label: '실시간 실패', source: 'mock', reason: 'quota' },
};
/** 미리보기에서 고르는 예시 돌발정보 상황 */
export const PREVIEW_INCIDENTS = { all: '공사+행사', campus: '행사만', none: '없음' };
/** 미리보기에서 고르는 예시 날씨 */
export const PREVIEW_WEATHER = { rain: '비', snow: '눈', clear: '맑음' };
/** 미리보기에서 고르는 '왜 늦나요?' 모양(예시 문장 · 실제 AI 응답 아님) */
export const PREVIEW_EXPLAIN = { ai: 'AI 문장', rule: '기본 안내' };
/** 미리보기에서 고르는 가상 기기(아이폰 홈 화면 추가 안내 · 백그라운드 알림 화면 확인용) */
export const PREVIEW_DEVICES = { pc: 'PC', safari: '아이폰 Safari', app: '아이폰 앱', inapp: '카카오톡' };

/**
 * 탑승 정류장 → 국민대행 노선별 실시간 도착·차내 시간·정체.
 * api: 20초마다 /api/stops/:arsId/trips. 그 사이에는 받은 뒤 흐른 시간만큼 도착 예정을 줄여 카운트다운.
 *      서버가 서울시 API를 못 쓰면 직전 값(stale) 또는 예시 데이터(source 'mock' + reason)를 보내 줍니다.
 * sample: 샘플 응답 재생(미리보기). previewSource로 배지 상태만 바꿔 볼 수 있습니다.
 *      응답의 incidents(경로 주변 서울시 돌발정보) · weather(기상청 초단기실황)도 그대로 넘깁니다.
 *      미리보기는 예시 돌발정보(previewIncidents) · 예시 날씨(previewWeather)를 만듭니다.
 *      노선마다 delayMin(서버 계산 지연 분) · 막힐 때 explain('왜 늦나요?' 한 줄)이 붙어 옵니다. 미리보기는 예시 문장(previewExplain).
 * @returns {{ status:'idle'|'loading'|'ok'|'stale'|'error', trips, incidents?, weather?, source?, reason?, stale?, ageSec?, at?, fetchedMin?, error? }}
 */
export function useTrips({ mode, stop, now, previewSource = 'live', previewIncidents = 'all', previewWeather = 'rain', previewExplain = 'ai' }) {
  const sampleKey = mode === 'sample' ? Math.floor((now.elapsedSec || 0) / 5) : 0;
  const sample = useMemo(() => {
    if (mode !== 'sample' || !stop) return null;
    const { label, ...src } = PREVIEW_SOURCES[previewSource] || PREVIEW_SOURCES.live;
    const raw = sampleTrips(stop.arsId, now.elapsedSec || 0);
    const incidents = sampleIncidents(raw, now.minutes, previewIncidents, src.source);
    const weather = sampleWeather(now.minutes, previewWeather, src.source);
    const trips = sampleExplain(raw, { incidents, weather, busSource: src.source, variant: previewExplain });
    return { status: 'ok', trips, incidents, weather, fetchedMin: now.minutes, preview: true, ...src };
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [mode, stop?.arsId, sampleKey, previewSource, previewIncidents, previewWeather, previewExplain]);

  const [live, setLive] = useState({ status: 'idle', trips: [] });
  useEffect(() => {
    if (mode !== 'api' || !stop) return undefined;
    let alive = true, retry = null, retries = 0;
    setLive((l) => ({ ...l, status: l.trips.length ? l.status : 'loading' }));
    const load = async () => {
      try {
        const j = await api.trips(stop.arsId);
        if (!alive) return;
        setLive({ status: 'ok', trips: j.trips || [], incidents: j.incidents || null, weather: j.weather || null, at: Date.now(), fetchedMin: now.minutes,
          source: j.source || 'seoul', reason: j.reason || null, stale: Boolean(j.stale), ageSec: j.ageSec || 0 });
        clearTimeout(retry);
        if ((j.trips || []).some((t) => t.explain?.pending) && retries < 2) { retries += 1; retry = setTimeout(load, PENDING_RETRY_MS); }
        else retries = 0;
      } catch (e) { if (alive) setLive((l) => ({ ...l, status: l.trips.length ? 'stale' : 'error', error: e.message })); }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); clearTimeout(retry); };
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
