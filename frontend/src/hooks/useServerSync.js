import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * (실서비스) 시간표·탑승 정류장·설정을 서버와 동기화 — 서버 스케줄러가 같은 값으로 푸시 알림을 보냅니다.
 * @returns {{ status:'off'|'loading'|'synced'|'error', pushSubscriptions:number }}
 */
export function useServerSync(state, dispatch, enabled) {
  const [status, setStatus] = useState(enabled ? 'loading' : 'off');
  const [pushSubscriptions, setPushSubscriptions] = useState(0);
  const loaded = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    api.me().then(async (me) => {
      setPushSubscriptions(me.pushSubscriptions || 0);
      // 서버가 다시 시작되며 저장 내용을 잃었을 때(무료 호스팅의 임시 저장소 등): 이 기기에 있는 값을 서버로 되살림
      const serverEmpty = !me.stop && !(me.classes || []).length;
      if (serverEmpty && (state.stop || state.classes.length)) {
        await api.saveTimetable(state.classes);
        await api.saveMe({ stop: state.stop, prefs: state.prefs, walkOverrides: state.walkOverrides });
      } else {
        dispatch({ type: 'hydrate', patch: { classes: me.classes || [], stop: me.stop || null, prefs: { ...state.prefs, ...(me.prefs || {}) }, walkOverrides: me.walkOverrides || {}, sampleTimetable: false } });
      }
      loaded.current = true; setStatus('synced');
    }).catch(() => setStatus('error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !loaded.current) return undefined;
    const t = setTimeout(() => api.saveTimetable(state.classes).then(() => setStatus('synced')).catch(() => setStatus('error')), 600);
    return () => clearTimeout(t);
  }, [enabled, state.classes]);
  useEffect(() => {
    if (!enabled || !loaded.current) return undefined;
    const t = setTimeout(() => api.saveMe({ stop: state.stop, prefs: state.prefs, walkOverrides: state.walkOverrides }).then(() => setStatus('synced')).catch(() => setStatus('error')), 400);
    return () => clearTimeout(t);
  }, [enabled, state.stop, state.prefs, state.walkOverrides]);
  return { status, pushSubscriptions };
}
