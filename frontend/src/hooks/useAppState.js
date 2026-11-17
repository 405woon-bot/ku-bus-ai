/* global __DATA_MODE__ */
import { useEffect, useReducer } from 'react';
import { DEFAULTS } from '@shared/recommend.js';
import { emptyPersonal } from '@shared/arrival.js';
import { SAMPLE_CLASSES } from '../data/sampleTimetable.js';
import { loadState, saveState } from '../lib/platform.js';

export const MODE = typeof __DATA_MODE__ !== 'undefined' ? __DATA_MODE__ : 'api';
const VERSION = 2;

export const initialState = () => ({
  v: VERSION,
  classes: MODE === 'sample' ? SAMPLE_CLASSES : [],
  sampleTimetable: MODE === 'sample',
  // 집 주소 대신 탑승 정류장 하나만 저장
  stop: MODE === 'sample' ? { arsId: 'S-01', name: '고려대사범대학부속고등학교' } : null,
  prefs: { walkToStopMin: DEFAULTS.walkToStopMin, marginMin: DEFAULTS.marginMin, notify: true, notifyBeforeMin: DEFAULTS.notifyBeforeMin },
  walkOverrides: {},
  preview: { speed: 1, epoch: 1, source: 'live', incidents: 'all', weather: 'rain', explain: 'ai', device: 'pc', at: null, jump: 0 },   // 미리보기 시계(시각 이동 at)·배지·예시 돌발정보·예시 날씨·'왜 늦나요?' 모양·가상 기기(샘플 모드 전용)
  fired: {},                         // `${날짜}:${수업id}` → 보낸 알림
  personal: emptyPersonal(),         // 내 걸음 반영(실서비스는 서버 값을 받아 둠)
  arrivals: [],                      // 최근 도착 기록(같은 날 같은 수업은 한 번)
  transit: emptyTransit(),           // v2.0 출발 방식: direct(단일 정류장 직행) | transit(출발지 환승 경로) + 고른 경로
  log: [],
});

export function emptyTransit() { return { mode: 'direct', origin: null, route: null, savedAt: null }; }

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

function reducer(s, a) {
  switch (a.type) {
    case 'addClasses': return { ...s, sampleTimetable: false, classes: [...s.classes, ...a.items.map((c) => ({ ...c, id: newId() }))] };
    case 'replaceClasses': return { ...s, sampleTimetable: false, classes: a.items.map((c) => ({ ...c, id: newId() })), fired: {} };
    case 'updateClass': return { ...s, sampleTimetable: false, classes: s.classes.map((c) => (c.id === a.item.id ? { ...c, ...a.item } : c)) };
    case 'deleteClass': return { ...s, sampleTimetable: false, classes: s.classes.filter((c) => c.id !== a.id) };
    case 'deleteCourse': return { ...s, sampleTimetable: false, classes: s.classes.filter((c) => c.courseId !== a.courseId) }; // 수업 검색으로 넣은 강의(요일 여러 개)를 한 번에
    // 겹치는 과목을 빼고 강의를 넣기(시간표에 겹치는 수업이 남지 않게) · 되돌리기
    case 'swapClasses': return { ...s, sampleTimetable: false, classes: [...s.classes.filter((c) => !a.removeIds.includes(c.id)), ...a.items.map((c) => ({ ...c, id: newId() }))] };
    case 'restoreClasses': return { ...s, classes: a.classes };
    case 'setStop': return { ...s, stop: a.stop, fired: {} };
    case 'setPrefs': return { ...s, prefs: { ...s.prefs, ...a.patch } };
    case 'setPreview': return { ...s, preview: { ...s.preview, ...a.patch, epoch: a.rearm ? s.preview.epoch + 1 : s.preview.epoch }, fired: a.rearm || a.clearFired ? {} : s.fired };
    case 'alarmFired': {
      const cur = s.fired[a.key] || {};
      const slot = a.alarm.type === 'earlier' ? 'depart' : a.alarm.type;
      return { ...s, fired: { ...s.fired, [a.key]: { ...cur, [slot]: { departMin: a.alarm.departMin } } }, log: [{ ...a.alarm, key: a.key }, ...s.log].slice(0, 20) };
    }
    case 'transitSaved': return { ...s, transit: { ...emptyTransit(), ...(a.transit || {}) } };
    case 'arrivalSaved': return { ...s, personal: a.personal || emptyPersonal(), arrivals: Array.isArray(a.arrivals) ? a.arrivals : s.arrivals };
    case 'hydrate': return { ...s, ...a.patch };
    case 'resetAll': return initialState();
    default: return s;
  }
}

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, null, () => {
    const saved = loadState();
    return saved && saved.v === VERSION ? { ...initialState(), ...saved } : initialState();
  });
  useEffect(() => { const t = setTimeout(() => saveState(state), 300); return () => clearTimeout(t); }, [state]);
  return [state, dispatch];
}
