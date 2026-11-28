import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { emptyPersonal } from '@shared/arrival.js';

/**
 * v2.2 '출발했어요!' 기록: 서버 값이 정답. 같은 기록이면 이 기기에만 둔 '이미 탔음' 고정값(pins)은 그대로 두고,
 * 서버에 없는데 이 기기에 아직 못 보낸 기록(pending)이 있으면 남겨 둠(useDeparture가 다시 보냄)
 */
export function mergeDeparture(server, local) {
  const srv = server && typeof server === 'object' && server.key ? server : null;
  if (srv) return { ...srv, ...(local && local.key === srv.key && local.routeKey === srv.routeKey && local.pins ? { pins: local.pins } : {}) };
  return local?.pending ? local : null;
}

// v2.8.0 앱으로 돌아왔을 때 서버 값을 다시 받는 간격(마지막으로 받은 지 1분이 넘었을 때만)
export const REFRESH_AFTER_MS = 60_000;
const J = (v) => JSON.stringify(v ?? null);
/** 설정 묶음 — PATCH /api/me로 보내는 것(정류장 · 설정값 · 캠퍼스 걷는 시간) */
const settingsOf = (s) => ({ stop: s.stop ?? null, prefs: s.prefs, walkOverrides: s.walkOverrides ?? {} });
/** 서버가 보낸 버전 번호 { timetable, settings }(없으면 0 — 예전 서버) */
const revOf = (me) => ({ timetable: Number(me?.rev?.timetable) || 0, settings: Number(me?.rev?.settings) || 0 });
const timetableFrom = (me) => (Array.isArray(me?.classes) ? me.classes : []);
const settingsFrom = (me, s) => ({ stop: me?.stop || null, prefs: { ...s.prefs, ...(me?.prefs || {}) }, walkOverrides: me?.walkOverrides || {} });
/** 서버가 정답인 값: 내 걸음 반영 · 도착 기록(서버가 배움) · 출발 방식 · 고른 환승 경로 · 출발 기록 */
function learnedFrom(me, s) {
  return {
    personal: me.personal || emptyPersonal(),
    arrivals: Array.isArray(me.arrivals) ? me.arrivals : [],
    transit: me.transit ? { mode: me.transit.mode === 'transit' ? 'transit' : 'direct', origin: me.transit.origin || null, route: me.transit.route || null, savedAt: me.transit.savedAt || null, retry: me.transit.retry || null } : s.transit,
    departure: mergeDeparture(me.departure, s.departure),
  };
}

/**
 * (실서비스) 시간표·탑승 정류장·설정을 서버와 동기화 — 서버 스케줄러가 같은 값으로 푸시 알림을 보냅니다.
 *   v2.8.0(승인한 설계안 그대로):
 *   · 서버와 같은 값은 보내지 않음 — 예전에는 앱을 열 때마다 받은 시간표를 그대로 다시 저장했고, 서버가 그때 '보낸 알림' 기록을 지워
 *     출발 알림을 받은 뒤 앱을 열면 1분 뒤 같은 알림이 또 갔음
 *   · 버전 번호: 저장할 때 받은 버전(baseRev)을 같이 보냄. 그사이 다른 기기 · 화면이 바꿨으면 서버가 409로 지금 값을 주고,
 *     이 화면은 그 값으로 바꾼 뒤 안내('다른 기기에서 바꾼 내용을 불러왔어요…') — 다른 기기의 새 변경을 덮어쓰지 않음
 *   · 저장은 칸(시간표 · 설정)마다 한 번에 하나씩 — 느린 연결에서 연달아 고쳐도 자기 저장끼리 겹치지 않음
 *   · 앱으로 돌아올 때(마지막으로 받은 지 1분이 넘었으면) 서버 값을 다시 받아 다른 기기에서 바꾼 것을 보여 줌(이 화면에 아직 안 보낸 것은 덮어쓰지 않음)
 * @returns {{ status:'off'|'loading'|'synced'|'error', pushSubscriptions:number, staleAt:number }}  staleAt: 다른 기기 값을 불러온 때(안내 띄우기용)
 */
export function useServerSync(state, dispatch, enabled) {
  const [status, setStatus] = useState(enabled ? 'loading' : 'off');
  const [pushSubscriptions, setPushSubscriptions] = useState(0);
  const [staleAt, setStaleAt] = useState(0);
  const loaded = useRef(false);
  const latest = useRef(state);
  latest.current = state;
  const rev = useRef({ timetable: 0, settings: 0 });
  const synced = useRef({ timetable: null, settings: null }); // 서버와 같다고 아는 값(JSON)
  const busy = useRef({ timetable: false, settings: false });
  const again = useRef({ timetable: false, settings: false });
  const lastLoad = useRef(0);

  // 저장이 겹쳤을 때(409): 서버의 지금 값으로 바꾸고 안내 — 이 화면에서 방금 바꾼 것은 다시 하도록(덮어쓰지 않음)
  const onStale = useRef(null);
  onStale.current = (k, data) => {
    if (data?.rev) rev.current = revOf(data);
    if (k === 'timetable') {
      const classes = timetableFrom(data);
      synced.current = { ...synced.current, timetable: J(classes) };
      dispatch({ type: 'hydrate', patch: { classes, sampleTimetable: false } });
    } else {
      const set = settingsFrom(data, latest.current);
      synced.current = { ...synced.current, settings: J(set) };
      dispatch({ type: 'hydrate', patch: set });
    }
    again.current = { ...again.current, [k]: false };
    setStaleAt(Date.now());
    setStatus('synced');
  };

  // 칸 하나 저장: 서버와 같으면 보내지 않음 · 저장 중이면 끝난 뒤 한 번 더
  const save = useRef(null);
  save.current = (k) => {
    if (!loaded.current) return;
    if (busy.current[k]) { again.current = { ...again.current, [k]: true }; return; }
    const s = latest.current;
    const value = k === 'timetable' ? s.classes : settingsOf(s);
    const body = J(value);
    if (body === synced.current[k]) return;
    busy.current = { ...busy.current, [k]: true };
    const call = k === 'timetable' ? api.saveTimetable(value, rev.current.timetable) : api.saveMe(value, rev.current.settings);
    call.then((r) => {
      if (r?.rev) rev.current = { ...rev.current, [k]: Number(r.rev[k]) || 0 };
      synced.current = { ...synced.current, [k]: body };
      setStatus('synced');
    }).catch((e) => {
      if (e?.status === 409 && e.kind === 'stale') onStale.current(k, e.data);
      else setStatus('error');
    }).finally(() => {
      busy.current = { ...busy.current, [k]: false };
      if (again.current[k]) { again.current = { ...again.current, [k]: false }; save.current(k); }
    });
  };

  useEffect(() => {
    if (!enabled) return;
    api.me().then(async (me) => {
      const s = latest.current;
      setPushSubscriptions(me.pushSubscriptions || 0);
      rev.current = revOf(me);
      // 서버가 다시 시작되며 저장 내용을 잃었을 때(무료 호스팅의 임시 저장소 · 90일 자동 삭제 뒤 등): 이 기기에 있는 값을 서버로 되살림
      const serverEmpty = !me.stop && !(me.classes || []).length;
      const learned = learnedFrom(me, s);
      if (serverEmpty && (s.stop || s.classes.length)) {
        const r1 = await api.saveTimetable(s.classes, rev.current.timetable);
        const r2 = await api.saveMe(settingsOf(s), rev.current.settings);
        rev.current = { timetable: Number(r1?.rev?.timetable ?? rev.current.timetable) || 0, settings: Number(r2?.rev?.settings ?? rev.current.settings) || 0 };
        synced.current = { timetable: J(s.classes), settings: J(settingsOf(s)) };
        dispatch({ type: 'hydrate', patch: learned });
      } else {
        const classes = timetableFrom(me), set = settingsFrom(me, s);
        synced.current = { timetable: J(classes), settings: J(set) };
        dispatch({ type: 'hydrate', patch: { classes, ...set, sampleTimetable: false, ...learned } });
      }
      lastLoad.current = Date.now();
      loaded.current = true; setStatus('synced');
    }).catch(() => setStatus('error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !loaded.current || J(state.classes) === synced.current.timetable) return undefined;
    const t = setTimeout(() => save.current('timetable'), 600);
    return () => clearTimeout(t);
  }, [enabled, state.classes]);
  useEffect(() => {
    if (!enabled || !loaded.current || J(settingsOf(state)) === synced.current.settings) return undefined;
    const t = setTimeout(() => save.current('settings'), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state.stop, state.prefs, state.walkOverrides]);

  // 앱으로 돌아올 때: 다른 기기에서 바꾼 시간표 · 설정 · 경로 · 출발 기록을 받아 옴(서버 호출 하나 — 교통 API는 부르지 않음)
  useEffect(() => {
    if (!enabled) return undefined;
    const on = () => {
      if (document.visibilityState !== 'visible' || !loaded.current || Date.now() - lastLoad.current < REFRESH_AFTER_MS) return;
      lastLoad.current = Date.now();
      api.me().then((me) => {
        const s = latest.current, r = revOf(me), patch = {};
        setPushSubscriptions(me.pushSubscriptions || 0);
        for (const [k, v] of Object.entries(learnedFrom(me, s))) if (J(v) !== J(s[k])) patch[k] = v;
        // 이 화면에 아직 서버로 안 보낸 칸은 덮어쓰지 않음(보낼 때 버전으로 확인)
        if (!busy.current.timetable && J(s.classes) === synced.current.timetable && r.timetable !== rev.current.timetable) {
          const classes = timetableFrom(me);
          rev.current = { ...rev.current, timetable: r.timetable };
          synced.current = { ...synced.current, timetable: J(classes) };
          if (J(classes) !== J(s.classes)) Object.assign(patch, { classes, sampleTimetable: false });
        }
        if (!busy.current.settings && J(settingsOf(s)) === synced.current.settings && r.settings !== rev.current.settings) {
          const set = settingsFrom(me, s);
          rev.current = { ...rev.current, settings: r.settings };
          synced.current = { ...synced.current, settings: J(set) };
          if (J(set) !== J(settingsOf(s))) Object.assign(patch, set);
        }
        if (Object.keys(patch).length) dispatch({ type: 'hydrate', patch });
      }).catch(() => { /* 다음에 돌아올 때 */ });
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [enabled, dispatch]);

  return { status, pushSubscriptions, staleAt };
}
