import { useEffect, useReducer } from 'react';
import { EXAMPLE_ROUTES } from '@shared/transitModel.js';
import { DEFAULT_MARGIN_MIN, DEFAULT_NOTIFY_BEFORE_MIN } from '@shared/departure.js';
import { SAMPLE_CLASSES } from '../data/sampleTimetable.js';
import { loadState, saveState } from '../lib/platform.js';
/* global __DATA_MODE__ */
const MODE = typeof __DATA_MODE__ !== 'undefined' ? __DATA_MODE__ : 'mock';

const VERSION = 1;
export const initialState = () => ({
  v: VERSION,
  classes: SAMPLE_CLASSES,
  sampleTimetable: true,
  routes: EXAMPLE_ROUTES,
  primaryRouteId: '171',
  settings: { marginMin: DEFAULT_MARGIN_MIN, notifyBeforeMin: DEFAULT_NOTIFY_BEFORE_MIN, alarms: true },
  walkOverrides: {},
  // 데모 시계: 실제 시각 대신 원하는 요일·시각에서 흘러가게 해 알림을 시험합니다.
  demo: { enabled: MODE === 'mock', weekday: 0, time: '08:10', speed: 1, scenario: 'jeongneung', epoch: 1 },
  fired: {},   // `${dateKey}:${classId}` → { delay:{delayMin}, depart:{} }
  log: [],     // 최근 알림 20건
});

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

function reducer(s, a) {
  switch (a.type) {
    case 'addClasses': return { ...s, sampleTimetable: false, classes: [...s.classes, ...a.items.map((c) => ({ ...c, id: newId() }))] };
    case 'replaceClasses': return { ...s, sampleTimetable: false, classes: a.items.map((c) => ({ ...c, id: newId() })), fired: {} };
    case 'updateClass': return { ...s, sampleTimetable: false, classes: s.classes.map((c) => (c.id === a.item.id ? { ...c, ...a.item } : c)) };
    case 'deleteClass': return { ...s, sampleTimetable: false, classes: s.classes.filter((c) => c.id !== a.id) };
    case 'clearClasses': return { ...s, sampleTimetable: false, classes: [], fired: {} };
    case 'setPrimary': return { ...s, primaryRouteId: a.id };
    case 'updateRoute': return { ...s, routes: s.routes.map((r) => (r.id === a.id ? { ...r, ...a.patch } : r)) };
    case 'setSettings': return { ...s, settings: { ...s.settings, ...a.patch } };
    case 'setWalk': {
      const row = { ...(s.walkOverrides[a.building] || {}) };
      if (a.minutes === null) delete row[a.gate]; else row[a.gate] = a.minutes;
      return { ...s, walkOverrides: { ...s.walkOverrides, [a.building]: row } };
    }
    case 'setDemo': {
      const demo = { ...s.demo, ...a.patch };
      const rearm = a.rearm ? { epoch: s.demo.epoch + 1 } : {};
      return { ...s, demo: { ...demo, ...rearm } };
    }
    case 'alarmFired': {
      const cur = s.fired[a.key] || {};
      const rec = a.alarm.type === 'worse' ? { delay: { delayMin: a.alarm.delayMin } } : { [a.alarm.type]: { delayMin: a.alarm.delayMin } };
      return { ...s, fired: { ...s.fired, [a.key]: { ...cur, ...rec } }, log: [{ ...a.alarm, key: a.key }, ...s.log].slice(0, 20) };
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
