import { useCallback, useEffect, useRef, useState } from 'react';
import { decideAlarms } from '@shared/recommend.js';
import { showSystemNotification } from '../lib/platform.js';

const SEVERITY = { danger: 2, warn: 1 };
/** 예시(모의) 데이터로 계산한 알림에 붙이는 출처 표시 — 서버 푸시와 같은 문구 */
export const MOCK_NOTE = ' (예시 교통 데이터 기준 · 실시간 아님)';

/**
 * 추천 결과로 알림 판정 → 시스템 알림(Web Notification) + 화면 알림.
 * - 같은 날·같은 수업·같은 종류는 한 번만
 * - 한 번에 여러 개가 걸리면(예: 출발 10분 전 + 빠듯) 하나로 합쳐서 보냄
 * - 지난 출발 시각에 대한 알림은 화면에서 자동으로 치움
 * - mockData: 서울시 실시간 대신 예시 데이터로 계산한 추천 → 본문에 출처를 밝히고 따로 기록(실시간이 돌아오면 다시 알림)
 */
export function useAlarms({ rec, now, fired, dispatch, prefs, mockData = false }) {
  const [toasts, setToasts] = useState([]);
  const sent = useRef(new Set());
  const snoozes = useRef([]);
  const qKey = Math.floor(now.minutes * 4);

  const show = useCallback(async (a, tag) => {
    const id = `${tag}:${Date.now()}`;
    setToasts([{ ...a, id }]); // 화면에는 가장 최근 것 하나만
    showSystemNotification({ title: a.title, body: a.body, tag });
  }, []);

  useEffect(() => {
    // 지난 출발 시각 알림 치우기
    setToasts((ts) => { const keep = ts.filter((t) => t.departMin == null || t.departMin >= now.minutes - 1); return keep.length === ts.length ? ts : keep; });
    if (!prefs.notify || !rec || rec.state !== 'ok') return;
    const key = `${now.dateKey}:${rec.cls.id}${mockData ? ':mock' : ''}`;
    const fresh = [];
    for (const d of decideAlarms({ rec, nowMin: now.minutes, fired: fired[key] || {}, notifyBeforeMin: prefs.notifyBeforeMin })) {
      const a = mockData ? { ...d, body: `${d.body}${MOCK_NOTE}`, mock: true } : d;
      const sig = `${key}:${a.type}:${a.type === 'earlier' ? Math.round(a.departMin) : ''}`;
      if (sent.current.has(sig)) continue;
      sent.current.add(sig);
      dispatch({ type: 'alarmFired', key, alarm: { type: a.type, departMin: a.departMin, atMin: now.minutes, title: a.title, mock: Boolean(a.mock) } });
      fresh.push(a);
    }
    if (fresh.length) {
      const main = fresh.find((a) => a.type === 'depart') || fresh.find((a) => a.type === 'earlier') || fresh[0];
      const tone = fresh.reduce((t, a) => ((SEVERITY[a.tone] || 0) > (SEVERITY[t] || 0) ? a.tone : t), main.tone);
      show({ ...main, tone }, `${key}:${main.type}`);
    }
    const due = snoozes.current.filter((s) => now.minutes >= s.atMin);
    if (due.length) {
      snoozes.current = snoozes.current.filter((s) => now.minutes < s.atMin);
      const last = due[due.length - 1].toast;
      if (last.departMin == null || last.departMin >= now.minutes - 1) show({ ...last, title: `다시 알림 · ${last.title.replace(/^다시 알림 · /, '')}` }, 'snooze');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, qKey, prefs.notify, prefs.notifyBeforeMin, now.dateKey, mockData]);

  useEffect(() => { setToasts([]); snoozes.current = []; }, [now.dateKey]);
  const dismiss = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const snooze = useCallback((t) => { snoozes.current.push({ atMin: now.minutes + 5, toast: t }); dismiss(t.id); }, [now.minutes, dismiss]);
  const test = useCallback(() => show({ type: 'test', tone: 'ok', title: '테스트 알림', body: '출발 시각이 되면 이렇게 알려 드려요.' }, 'test'), [show]);
  return { toasts, dismiss, snooze, test };
}
