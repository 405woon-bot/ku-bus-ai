import { useCallback, useEffect, useRef, useState } from 'react';
import { decideAlarms } from '@shared/departure.js';
import { showSystemNotification } from '../lib/platform.js';

/**
 * 계획(plan)과 현재 시각으로 알림을 판정해 ① 시스템 알림(Web Notification) ② 화면 팝업을 띄웁니다.
 * 같은 날·같은 수업·같은 종류의 알림은 한 번만(지연 악화는 3분 늘 때마다) 보냅니다.
 */
export const MOCK_NOTE = ' (예시 교통 데이터 기준 · 실시간 아님)';

/**
 * @param {object} p
 * @param {boolean} [p.mockFallback] (api 모드) 서울시 대신 예시 데이터로 계산된 계획 → 알림 본문에 출처를 밝히고,
 *   기록 키를 따로 써서 실시간 데이터가 돌아오면 알림을 다시 판단합니다(서버 스케줄러와 같은 규칙).
 */
export function useAlarms({ plan, now, fired, dispatch, enabled, mockFallback = false }) {
  const [toasts, setToasts] = useState([]);
  const snoozes = useRef([]); // { atMin, toast }
  const sent = useRef(new Set()); // 개발 모드(StrictMode) 이중 실행에도 한 번만 보내도록
  const minuteKey = Math.floor(now.minutes * 4); // 15초 단위로 판정

  const push = useCallback(async (a, key) => {
    const system = await showSystemNotification({ title: a.title, body: a.body, tag: `${key}:${a.type}` });
    // 실시간 알림이 오면 예시 데이터로 띄웠던 팝업은 치움
    setToasts((ts) => [{ ...a, id: `${key}:${a.type}:${Date.now()}`, system, atMin: now.minutes }, ...ts.filter((t) => t.body !== a.body && !(t.mock && !a.mock))].slice(0, 2));
  }, [now.minutes]);

  useEffect(() => {
    if (!plan || !enabled) return;
    const key = `${now.dateKey}:${plan.cls.id}${mockFallback ? ':mock' : ''}`;
    for (const d of decideAlarms({ plan, nowMin: now.minutes, fired: fired[key] || {} })) {
      const a = mockFallback ? { ...d, body: `${d.body}${MOCK_NOTE}`, mock: true } : d;
      const sig = `${key}:${a.type}:${a.type === 'worse' ? a.delayMin : ''}`;
      if (sent.current.has(sig)) continue;
      sent.current.add(sig);
      dispatch({ type: 'alarmFired', key, alarm: { type: a.type, delayMin: a.delayMin, atMin: now.minutes, title: a.title, body: a.body, level: a.level, mock: Boolean(a.mock) } });
      push(a, key);
    }
    // 다시 알림(스누즈)
    const due = snoozes.current.filter((s) => now.minutes >= s.atMin);
    if (due.length) {
      snoozes.current = snoozes.current.filter((s) => now.minutes < s.atMin);
      due.forEach((s) => push({ ...s.toast, title: `다시 알림 · ${s.toast.title}` }, 'snooze'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, minuteKey, enabled, now.dateKey, mockFallback]);

  // 데모 시각을 옮기면(날짜 키가 바뀌면) 이전 팝업은 정리
  useEffect(() => { setToasts([]); snoozes.current = []; }, [now.dateKey]);
  const dismiss = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const snooze = useCallback((t, minutes = 5) => { snoozes.current.push({ atMin: now.minutes + minutes, toast: t }); dismiss(t.id); }, [now.minutes, dismiss]);
  const preview = useCallback(() => {
    if (!plan) return;
    push({ type: 'preview', level: plan.level, title: `미리 보기 · ${plan.primary.no}번 ${plan.delayed ? `+${plan.primary.delayMin}분 지연` : '정상 운행'}`, body: plan.message }, 'preview');
  }, [plan, push]);
  return { toasts, dismiss, snooze, preview };
}
