import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { arrivalKey, arrivalWindow, emptyPersonal, keepArrivals, recordArrival, undoArrival } from '@shared/arrival.js';
import { api } from '../lib/api.js';

// 보내지 못한 도착 기록(연결 끊김 · 서버 잠듦): 이 기기에 두었다가 다시 보냄 — 누른 시각을 그대로 보내므로 늦게 보내도 정확
const PENDING = 'kubusai:arrival:pending';
const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING) || 'null'); } catch { return null; } };
const writePending = (j) => { try { localStorage.setItem(PENDING, JSON.stringify(j)); } catch { /* 저장 불가 환경 */ } };
const clearPending = () => { try { localStorage.removeItem(PENDING); } catch { /* 저장 불가 환경 */ } };
const RETRY_MS = [3000, 10000, 30000, 60000];

/**
 * '도착했어요!' — 오늘 첫 수업 도착 기록 · 내 걸음 반영(EMA) · K•CARD+ 보기
 *   실서비스: 서버(/api/me/arrival)가 시각 · 버튼 시간을 다시 확인하고 배워서 외부 DB(Upstash)에 저장
 *   미리보기: 같은 계산(shared/arrival.js)을 이 기기에서
 * @returns {{ win, phase, key, record, send, busy, canUndo, viewer, press(), view(), closeViewer(), undo(), reset() }}
 */
export function useArrival({ mode, state, dispatch, now, todayClass, ready }) {
  const quarter = Math.floor(now.minutes * 4); // 15초 단위로 다시 판단
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const win = useMemo(() => (todayClass ? arrivalWindow(todayClass, now.minutes) : null), [todayClass, quarter]);
  const key = todayClass ? arrivalKey(now.dateKey, todayClass) : null;
  const arrivals = state.arrivals || [];
  const record = key ? arrivals.find((a) => a.key === key) || null : null;
  const [sendAll, setSend] = useState(null);  // 이번에 누른 결과 { key, status:'saving'|'done'|'already'|'pending'|'error', record?, message? }
  const [viewer, setViewer] = useState(null); // K•CARD+ 크게 보기 { fromPress }
  const retry = useRef({ timer: null, n: 0 });
  const inflight = useRef(null); // 보내는 중인 기록(같은 기록을 두 번 보내지 않게)
  const latest = useRef(state); latest.current = state;

  const apply = useCallback((j) => {
    if (j && (j.personal || j.arrivals)) dispatch({ type: 'arrivalSaved', personal: j.personal, arrivals: j.arrivals });
  }, [dispatch]);

  const post = useCallback(async (job) => {
    if (inflight.current === job.key) return;
    inflight.current = job.key;
    clearTimeout(retry.current.timer);
    let again = 0;
    try {
      const r = await api.arrival({ classId: job.classId, pressedAt: job.pressedAt, sentAt: Date.now() });
      clearPending(); retry.current.n = 0;
      apply(r);
      setSend({ key: job.key, status: 'done', record: r.record });
    } catch (e) {
      if (e.status === 409 && e.data?.record) {
        // 앞서 보낸 것이 이미 들어갔는데 응답만 못 받은 경우(같은 누름)면 '기록 완료'로
        const same = Math.abs(Date.parse(e.data.record.at) - job.pressedAt) < 90_000;
        clearPending(); apply(e.data); setSend({ key: job.key, status: same ? 'done' : 'already', record: e.data.record });
      } else if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429) {
        clearPending(); apply(e.data); setSend({ key: job.key, status: 'error', message: e.message });
      } else { // 연결이 안 됨 · 서버 오류 → 이 기기에 두고 잠시 뒤 다시
        again = RETRY_MS[Math.min(retry.current.n++, RETRY_MS.length - 1)];
        setSend({ key: job.key, status: 'pending', pressedAt: job.pressedAt, message: e.message });
      }
    } finally {
      inflight.current = null;
      if (again) retry.current.timer = setTimeout(() => { const p = readPending(); if (p && p.key === job.key) post(p); }, again);
    }
  }, [apply]);

  // 앱을 다시 열거나 연결이 돌아오면: 같은 날 보내지 못한 기록을 다시 보냄(날이 바뀌었으면 버림)
  useEffect(() => {
    if (mode !== 'api' || !ready) return undefined;
    const resend = () => {
      const p = readPending();
      if (!p) return;
      if (!String(p.key || '').startsWith(`${now.dateKey}:`)) { clearPending(); return; }
      setSend((s) => (s && s.key === p.key ? s : { key: p.key, status: 'pending', pressedAt: p.pressedAt }));
      post(p);
    };
    resend();
    window.addEventListener('online', resend);
    const r = retry.current;
    return () => { window.removeEventListener('online', resend); clearTimeout(r.timer); };
  }, [mode, ready, now.dateKey, post]);

  const send = sendAll && sendAll.key === key ? sendAll : null;
  const busy = send?.status === 'saving';

  const press = useCallback(() => {
    if (!todayClass || !key || busy) return;
    setViewer({ fromPress: true });
    if (record) { setSend({ key, status: 'already', record }); return; }
    if (mode !== 'api') {
      const s = latest.current;
      const out = recordArrival(s.personal, { key, dateKey: now.dateKey, cls: todayClass, arriveMin: now.minutes, at: new Date().toISOString() });
      dispatch({ type: 'arrivalSaved', personal: out.personal, arrivals: keepArrivals([...(s.arrivals || []), out.record]) });
      setSend({ key, status: 'done', record: out.record });
      return;
    }
    const job = { key, classId: todayClass.id, pressedAt: Date.now() };
    writePending(job);
    setSend({ key, status: 'saving', pressedAt: job.pressedAt });
    post(job);
  }, [todayClass, key, busy, record, mode, now.dateKey, now.minutes, dispatch, post]);

  /** 잘못 누른 오늘 기록 되돌리기(가장 최근 기록만) */
  const undo = useCallback(async () => {
    if (!record) return false;
    if (mode !== 'api') {
      const s = latest.current, r = undoArrival(s.personal, s.arrivals, record.key, new Date().toISOString());
      if (r) { dispatch({ type: 'arrivalSaved', personal: r.personal, arrivals: r.arrivals }); setSend(null); }
      return Boolean(r);
    }
    try { apply(await api.arrivalUndo(record.key)); setSend(null); return true; }
    catch (e) { apply(e.data); setSend({ key: record.key, status: 'error', message: e.message }); return false; }
  }, [record, mode, dispatch, apply]);

  /** 내 걸음 반영 처음부터(보정 0 · 기록 지움) */
  const reset = useCallback(async () => {
    if (mode !== 'api') { dispatch({ type: 'arrivalSaved', personal: emptyPersonal(), arrivals: [] }); setSend(null); return true; }
    try { apply(await api.personalReset()); setSend(null); return true; } catch { return false; }
  }, [mode, dispatch, apply]);

  return {
    win, phase: win?.phase || null, key, record, send, busy,
    canUndo: Boolean(record && arrivals[arrivals.length - 1]?.key === record.key),
    viewer, press, undo, reset,
    view: useCallback(() => setViewer({ fromPress: false }), []),
    closeViewer: useCallback(() => setViewer(null), []),
  };
}
