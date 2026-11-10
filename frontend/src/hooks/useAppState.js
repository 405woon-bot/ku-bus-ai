/* global __DATA_MODE__ */
import { useEffect, useReducer } from 'react';
import { DEFAULTS } from '@shared/recommend.js';
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
  preview: { speed: 1, epoch: 1, source: 'live' },   // 미리보기 시계·배지 상태(샘플 모드 전용)
  fired: {},                         // `${날짜}:${수업id}` → 보낸 알림
  log: [],
});

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

function reducer(s, a) {
  switch (a.type) {
    case 'addClasses': return { ...s, sampleTimetable: false, classes: [...s.classes, ...a.items.map((c) => ({ ...c, id: newId() }))] };
    case 'replaceClasses': return { ...s, sampleTimetable: false, classes: a.items.map((c) => ({ ...c, id: newId() })), fired: {} };
    case 'updateClass': return { ...s, sampleTimetable: false, classes: s.classes.map((c) => (c.id === a.item.id ? { ...c, ...a.item } : c)) };
    case 'deleteClass': return { ...s, sampleTimetable: false, classes: s.classes.filter((c) => c.id !== a.id) };
    case 'setStop': return { ...s, stop: a.stop, fired: {} };
    case 'setPrefs': return { ...s, prefs: { ...s.prefs, ...a.patch } };
    case 'setPreview': return { ...s, preview: { ...s.preview, ...a.patch, epoch: a.rearm ? s.preview.epoch + 1 : s.preview.epoch }, fired: a.rearm ? {} : s.fired };
    case 'alarmFired': {
      const cur = s.fired[a.key] || {};
      const slot = a.alarm.type === 'earlier' ? 'depart' : a.alarm.type;
      return { ...s, fired: { ...s.fired, [a.key]: { ...cur, [slot]: { departMin: a.alarm.departMin } } }, log: [{ ...a.alarm, key: a.key }, ...s.log].slice(0, 20) };
    }
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
