/* global __DATA_MODE__ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { mockLive } from '@shared/transitModel.js';
import { routeStatus } from '@shared/departure.js';
import { api } from '../lib/api.js';

const withStatus = (r) => {
  const delayMin = Math.max(0, Math.round(r.liveMin - r.usualMin));
  return { ...r, delayMin, status: routeStatus(delayMin) };
};
/** 예시(모의) 데이터: 데모 빌드이거나 우리 서버에 연결할 수 없을 때 */
function localMock(routes, scenario, nowMin, reason) {
  const m = mockLive(routes, scenario, nowMin);
  return { ...m, routes: m.routes.map((r) => ({ ...withStatus(r), source: 'mock' })), source: 'mock', provider: 'mock', reason, updatedMin: nowMin };
}

/**
 * 노선별 실시간 소요시간
 * - mock(단일 HTML 데모): shared/transitModel.js 예시 시나리오 — 항상 '예시 데이터'
 * - api(백엔드와 배포): GET /api/live?routes=171,1711,1112 를 30초마다. 서버가 서울시 API → 실패 시 예시 데이터로 폴백하고
 *   source('seoul'|'mock')·reason을 알려 줌. 우리 서버 자체에 연결이 안 되면 화면에서 예시 데이터로 계산(이유: 서버 연결 안 됨)
 * 반환: { routes, cause, roadDelays, source, provider, reason, updatedMin, error?, loading? }
 */
export function useLiveRoutes({ routes, now, scenario }) {
  const mode = typeof __DATA_MODE__ !== 'undefined' ? __DATA_MODE__ : 'mock';
  const halfMin = Math.floor(now.minutes * 2);
  const mock = useMemo(() => (mode === 'mock' ? localMock(routes, scenario, now.minutes, 'demo') : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, routes, scenario, halfMin]);

  const [apiData, setApiData] = useState(null);
  const nowRef = useRef(now); nowRef.current = now;
  const routesRef = useRef(routes); routesRef.current = routes;
  const used = routes.filter((r) => r.enabled !== false);
  const ids = used.map((r) => r.id).join(',');
  // 승차 정류장·하차 정류장을 바꾸면 서버 저장(0.6초 뒤)이 끝난 다음 다시 불러옴
  const sig = used.map((r) => `${r.id}:${r.boardArsId || ''}:${r.alightName || ''}:${r.usualMin}`).join('|');
  const first = useRef(true);
  useEffect(() => {
    if (mode !== 'api') return undefined;
    let alive = true;
    const load = async () => {
      try {
        const j = await api.live(ids);
        const byId = Object.fromEntries(j.routes.map((r) => [r.id, r]));
        if (alive) setApiData({ ...j, source: j.source || j.provider, updatedMin: nowRef.current.minutes, routes: routesRef.current.map((r) => ({ ...r, ...(byId[r.id] || {}) })) });
      } catch (e) {
        if (!alive) return;
        setApiData((d) => (d && d.source === 'seoul' && !d.serverDown
          ? { ...d, error: e.message, stale: true }
          : { ...localMock(routesRef.current, 'jeongneung', nowRef.current.minutes, 'server'), error: e.message, serverDown: true }));
      }
    };
    const t = setTimeout(load, first.current ? 0 : 900);
    first.current = false;
    const id = setInterval(load, 30000);
    return () => { alive = false; clearTimeout(t); clearInterval(id); };
  }, [mode, ids, sig]);
  return mode === 'mock' ? mock : apiData || { routes, cause: null, source: 'api', loading: true };
}
