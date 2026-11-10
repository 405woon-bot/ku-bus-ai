import { useCallback, useEffect, useRef, useState } from 'react';
import { api, enableServerPush } from '../lib/api.js';

/**
 * (api 모드) 서버와 시간표·설정(노선별 승차 정류장 포함) 동기화 + 서버 푸시 구독.
 * 처음에 서버 값을 불러오고, 이후 바뀌면 0.6초 뒤 저장합니다. 서버 스케줄러가 같은 데이터로 알림을 계산해 Web Push를 보냅니다.
 * @returns {{ status:'off'|'loading'|'synced'|'error', error?:string, push:{ state:'idle'|'working'|'synced'|'error', message?:string }, enablePush:()=>Promise<void> }}
 */
export function useServerSync(state, dispatch, enabled) {
  const [status, setStatus] = useState(enabled ? 'loading' : 'off');
  const [error, setError] = useState('');
  const [push, setPush] = useState({ state: 'idle' });
  const loaded = useRef(false);
  const fail = (e) => { setStatus('error'); setError(e.message); };
  useEffect(() => {
    if (!enabled) return;
    api.me().then((me) => {
      dispatch({ type: 'hydrate', patch: { classes: me.classes, routes: me.routes, primaryRouteId: me.primaryRouteId, walkOverrides: me.walkOverrides || {}, sampleTimetable: false,
        settings: { ...state.settings, ...me.settings } } });
      if (me.pushSubscriptions > 0) setPush({ state: 'synced', message: `이 계정에 서버 푸시 구독 ${me.pushSubscriptions}개` });
      loaded.current = true; setStatus('synced'); setError('');
    }).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !loaded.current) return undefined;
    const t = setTimeout(() => api.saveTimetable(state.classes).then(() => { setStatus('synced'); setError(''); }).catch(fail), 600);
    return () => clearTimeout(t);
  }, [enabled, state.classes]);
  useEffect(() => {
    if (!enabled || !loaded.current) return undefined;
    const t = setTimeout(() => api.saveSettings({ ...state.settings, primaryRouteId: state.primaryRouteId, routes: state.routes, walkOverrides: state.walkOverrides })
      .then(() => { setStatus('synced'); setError(''); }).catch(fail), 600);
    return () => clearTimeout(t);
  }, [enabled, state.settings, state.primaryRouteId, state.routes, state.walkOverrides]);

  /** 서버 푸시 켜기: 서비스 워커 등록 → VAPID 구독 → 서버 저장 */
  const enablePush = useCallback(async () => {
    setPush({ state: 'working', message: '구독을 등록하는 중…' });
    try {
      await enableServerPush();
      const me = await api.me();
      setPush({ state: 'synced', message: `서버에 구독 저장됨(${me.pushSubscriptions}개) — 창을 닫아도 알림이 와요` });
    } catch (e) { setPush({ state: 'error', message: e.message }); }
  }, []);
  return { status, error, push, enablePush };
}
