import { useCallback, useEffect, useRef, useState } from 'react';
import { arrivalKey } from '@shared/arrival.js';
import { routeKey } from '@shared/transitPlan.js';
import { api } from '../lib/api.js';

const RETRY_MS = [3000, 10000, 30000, 60000];
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * v2.2 '출발했어요!' — 환승 경로로 안내 중인 날, 누른 시각을 오늘 출발 시각으로.
 *   이 기기 화면은 누르자마자 바뀌고(pending), 서버(/api/me/departure)가 시각 · 수업 · 경로를 다시 확인해 저장 → 그 수업의 출발 알림을 그만 보냄.
 *   연결이 안 되면 이 기기에 두었다가 다시 보냄(누른 시각 그대로 보내므로 늦게 보내도 정확). 미리보기는 이 기기에서만.
 *   기록은 오늘 · 이 수업 · 지금 경로(routeKey)와 맞을 때만 씀(날이 바뀌거나 경로를 바꾸면 무시)
 * @returns {{ record, departedMin: number|null, pins, busy, error, press(), undo(), savePins(pins) }}
 */
export function useDeparture({ mode, state, dispatch, now, todayClass, route, ready }) {
  const key = todayClass ? arrivalKey(now.dateKey, todayClass) : null;
  const rk = route ? routeKey(route) : '';
  const d = state.departure;
  const record = d && key && rk && d.key === key && d.routeKey === rk ? d : null;
  const [busy, setBusy] = useState(false); // 지우는 중
  const [error, setError] = useState(null);
  const retry = useRef({ timer: null, n: 0 });
  const latest = useRef(state); latest.current = state;

  const send = useCallback(async (job) => {
    clearTimeout(retry.current.timer);
    try {
      const r = await api.departure({ classId: job.classId, pressedAt: job.pressedAt, sentAt: Date.now(), routeKey: job.routeKey });
      retry.current.n = 0;
      const cur = latest.current.departure;
      if (!r.departure) return;
      if (!cur || cur.key !== r.departure.key) { api.departureUndo(r.departure.key).catch(() => {}); return; } // 보내는 동안 지웠음
      dispatch({ type: 'departureSaved', departure: { ...r.departure, pins: cur.pins || null } });
    } catch (e) {
      const cur = latest.current.departure;
      if (!cur || cur.key !== job.key || !cur.pending) return; // 그사이 지웠거나 이미 저장됨
      if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429) {
        // 시간 밖 · 경로 바뀜 등: 기록하지 않고 이유를 보여 줌(서버 기록이 있으면 그것으로)
        dispatch({ type: 'departureSaved', departure: e.data?.departure || null });
        setError(e.message);
      } else {
        const wait = RETRY_MS[Math.min(retry.current.n++, RETRY_MS.length - 1)];
        retry.current.timer = setTimeout(() => { const c = latest.current.departure; if (c?.pending && c.key === job.key) send(c); }, wait);
      }
    }
  }, [dispatch]);

  // 앱을 다시 열거나 연결이 돌아오면: 오늘 못 보낸 기록을 다시 보냄(날이 바뀌었으면 버림)
  useEffect(() => {
    if (mode !== 'api' || !ready) return undefined;
    const again = () => {
      const c = latest.current.departure;
      if (!c?.pending) return;
      if (!String(c.key || '').startsWith(`${now.dateKey}:`)) { dispatch({ type: 'departureSaved', departure: null }); return; }
      send(c);
    };
    again();
    window.addEventListener('online', again);
    const r = retry.current;
    return () => { window.removeEventListener('online', again); clearTimeout(r.timer); };
  }, [mode, ready, now.dateKey, send, dispatch]);

  const press = useCallback(() => {
    if (!key || !rk || !todayClass || record) return;
    setError(null);
    const rec = { key, routeKey: rk, departMin: r3(now.minutes), at: new Date().toISOString(), pins: null };
    if (mode !== 'api') { dispatch({ type: 'departureSaved', departure: rec }); return; }
    const job = { ...rec, pending: true, classId: todayClass.id, pressedAt: Date.now() };
    dispatch({ type: 'departureSaved', departure: job });
    send(job);
  }, [key, rk, todayClass, record, now.minutes, mode, dispatch, send]);

  /** 잘못 누른 출발 기록 지우기 → 누르기 전처럼 다시 계산 */
  const undo = useCallback(async () => {
    if (!record) return false;
    setError(null);
    if (mode !== 'api' || record.pending) { // 아직 서버에 없는 기록은 이 기기에서만 지움(보내는 중이었으면 저장된 뒤 서버에서도 지움)
      clearTimeout(retry.current.timer);
      dispatch({ type: 'departureSaved', departure: null });
      return true;
    }
    setBusy(true);
    try {
      await api.departureUndo(record.key);
      dispatch({ type: 'departureSaved', departure: null });
      return true;
    } catch (e) {
      if (e.status === 404) { dispatch({ type: 'departureSaved', departure: null }); return true; } // 서버에는 이미 없음
      setError(e.message || '출발 기록을 지우지 못했어요');
      return false;
    } finally { setBusy(false); }
  }, [record, mode, dispatch]);

  const savePins = useCallback((pins) => { if (record) dispatch({ type: 'departurePins', key: record.key, pins }); }, [record, dispatch]);
  const departedMin = record && Number.isFinite(Number(record.departMin)) ? Number(record.departMin) : null;
  return { record, departedMin, pins: record?.pins || null, busy, error, press, undo, savePins };
}
