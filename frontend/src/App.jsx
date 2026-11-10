import { useCallback, useEffect, useMemo, useState } from 'react';
import { firstClassOf, recommend } from '@shared/recommend.js';
import { WALK_TABLE } from '@shared/campusData.js';
import { MODE, useAppState } from './hooks/useAppState.js';
import { useNow } from './hooks/useNow.js';
import { useTrips } from './hooks/useTrips.js';
import { useAlarms } from './hooks/useAlarms.js';
import { useServerSync } from './hooks/useServerSync.js';
import { notifyPermission, requestNotifyPermission } from './lib/platform.js';
import { api, enableServerPush } from './lib/api.js';
import { colorIndexFor } from './lib/palette.js';
import { Header, PreviewBar, TabBar, TABS } from './components/AppShell.jsx';
import HomeScreen from './components/HomeScreen.jsx';
import TimetableScreen from './components/TimetableScreen.jsx';
import SettingsScreen from './components/SettingsScreen.jsx';
import StopPicker from './components/StopPicker.jsx';
import ClassDialog from './components/ClassDialog.jsx';
import ImportDialog from './components/ImportDialog.jsx';
import AlarmToasts from './components/AlarmToasts.jsx';

const readTab = () => { try { const h = window.location.hash.slice(1); return TABS.some((t) => t.id === h) ? h : 'home'; } catch { return 'home'; } };

/** #home · #timetable · #settings 해시 라우팅(뒤로 가기 지원, 막힌 환경에서는 화면 상태만 바꿈) */
function useTab() {
  const [tab, setTab] = useState(readTab);
  useEffect(() => {
    const on = () => setTab(readTab());
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener('popstate', on); };
  }, []);
  const go = useCallback((id) => {
    setTab(id);
    try { if (window.location.hash !== `#${id}`) window.history.pushState(null, '', `#${id}`); } catch { /* 샌드박스 */ }
    try { window.scrollTo(0, 0); } catch { /* 무시 */ }
  }, []);
  return [tab, go];
}

/** (실서비스) 서버 상태: 실시간 공급자(seoul/mock)·폴백 이유·서버 푸시 키 — 1분마다 */
function useHealth(enabled) {
  const [h, setH] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const load = () => api.health().then((j) => alive && setH(j)).catch(() => alive && setH({ provider: null, error: true }));
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [enabled]);
  return h;
}

function nextSchoolDay(classes, weekday) {
  for (let d = 1; d <= 7; d++) { const wd = (weekday + d) % 7; if (wd < 5) { const c = firstClassOf(classes, wd); if (c) return c; } }
  return null;
}

export default function App() {
  const [state, dispatch] = useAppState();
  const sync = useServerSync(state, dispatch, MODE === 'api');
  const [tab, go] = useTab();
  const now = useNow(MODE, state.preview);
  const live = useTrips({ mode: MODE, stop: state.stop, now, previewSource: state.preview.source });
  const mockData = live?.source === 'mock'; // 서울시 실시간 대신 예시 데이터로 계산 중
  const health = useHealth(MODE === 'api');

  // 캠퍼스 하차 문 → 강의 건물 도보(화면에는 표시하지 않고 계산에만 사용)
  const walkTable = useMemo(() => {
    const t = {};
    for (const [b, row] of Object.entries(WALK_TABLE)) t[b] = { ...row, ...(state.walkOverrides[b] || {}) };
    return t;
  }, [state.walkOverrides]);
  const todayClass = useMemo(() => (now.weekday < 5 ? firstClassOf(state.classes, now.weekday) : null), [state.classes, now.weekday]);
  const nextClass = useMemo(() => nextSchoolDay(state.classes, now.weekday), [state.classes, now.weekday]);
  const nowKey = Math.floor(now.minutes * 12); // 5초 단위로 다시 계산
  const { walkToStopMin, marginMin } = state.prefs;
  const rec = useMemo(() => (state.stop
    ? recommend({ trips: live.trips, cls: todayClass, nowMin: now.minutes, walkTable, walkToStopMin, marginMin })
    : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [state.stop, live, todayClass, nowKey, walkTable, walkToStopMin, marginMin]);
  const alarms = useAlarms({ rec, now, fired: state.fired, dispatch, prefs: state.prefs, mockData });

  const [perm, setPerm] = useState(notifyPermission);
  // 서버 푸시: off → working → on(synced) | error
  const [push, setPush] = useState({ state: 'off' });
  useEffect(() => { if (sync.pushSubscriptions > 0) setPush((p) => (p.state === 'off' ? { state: 'on', count: sync.pushSubscriptions } : p)); }, [sync.pushSubscriptions]);
  const enablePush = async () => {
    setPush({ state: 'working' });
    try {
      if (MODE !== 'api') throw new Error('미리보기에는 서버가 없어 켤 수 없어요');
      await enableServerPush();
      const me = await api.me();
      setPush({ state: 'on', count: me.pushSubscriptions });
    } catch (e) { setPush({ state: 'error', message: e.message }); }
    setPerm(notifyPermission());
  };

  const [dialog, setDialog] = useState(null);
  const close = useCallback(() => setDialog(null), []);
  const setStop = (stop) => { dispatch({ type: 'setStop', stop }); close(); go('home'); };

  return (
    <div className="min-h-full">
      <Header tab={tab} onTab={go} now={now} />
      {MODE === 'sample' && <PreviewBar preview={state.preview} dispatch={dispatch} />}

      <main className="gutter mx-auto max-w-[960px] pb-[calc(96px+env(safe-area-inset-bottom,0px))] pt-4 short:pt-3 md:pb-14 md:pt-8">
        {tab === 'home' && (
          <HomeScreen mode={MODE} syncing={sync.status === 'loading'} stop={state.stop} rec={rec} live={live} now={now} nextClass={nextClass} hasClasses={state.classes.length > 0}
            onPickStop={() => setDialog({ type: 'stop' })} onSelectStop={setStop} onGoTimetable={() => go('timetable')} />
        )}
        {tab === 'timetable' && (
          <TimetableScreen classes={state.classes} sample={state.sampleTimetable} now={now} highlightId={todayClass?.id} onOpen={setDialog} />
        )}
        {tab === 'settings' && (
          <SettingsScreen mode={MODE} state={state} dispatch={dispatch} onPickStop={() => setDialog({ type: 'stop' })}
            perm={perm} onRequestPerm={async () => setPerm(await requestNotifyPermission())} onTestAlarm={alarms.test}
            push={push} onEnablePush={enablePush} sync={sync.status} live={live} health={health} />
        )}
      </main>

      <TabBar tab={tab} onTab={go} />
      <AlarmToasts toasts={alarms.toasts} onDismiss={alarms.dismiss} onSnooze={alarms.snooze} />

      {dialog?.type === 'stop' && <StopPicker mode={MODE} onSelect={setStop} onClose={close} />}
      {dialog?.type === 'class' && (
        <ClassDialog initial={dialog.initial} classes={state.classes} onClose={close}
          onSave={(items) => {
            if (dialog.initial.id) dispatch({ type: 'updateClass', item: items[0] });
            else dispatch({ type: 'addClasses', items: items.map((it) => ({ ...it, color: it.color ?? colorIndexFor(it.name, state.classes) })) });
            close();
          }}
          onDelete={(id) => { dispatch({ type: 'deleteClass', id }); close(); }} />
      )}
      {dialog?.type === 'import' && (
        <ImportDialog initialTab={dialog.tab} classes={state.classes} onClose={close}
          onImport={(items, replace) => { dispatch({ type: replace ? 'replaceClasses' : 'addClasses', items }); close(); }} />
      )}
    </div>
  );
}
