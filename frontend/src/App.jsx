import { useCallback, useEffect, useMemo, useState } from 'react';
import { firstClassOf, recommend } from '@shared/recommend.js';
import { WALK_TABLE } from '@shared/campusData.js';
import { MODE, useAppState } from './hooks/useAppState.js';
import { useNow } from './hooks/useNow.js';
import { useTrips } from './hooks/useTrips.js';
import { useAlarms } from './hooks/useAlarms.js';
import { useServerSync } from './hooks/useServerSync.js';
import { notifyPermission, requestNotifyPermission } from './lib/platform.js';
import { api } from './lib/api.js';
import { deviceInfo, previewDevice } from './lib/device.js';
import { attachHandoffToUrl } from './lib/identity.js';
import { usePush } from './hooks/usePush.js';
import { colorIndexFor } from './lib/palette.js';
import { courseToClasses } from '@shared/courses.js';
import { Header, PreviewBar, TabBar, TABS } from './components/AppShell.jsx';
import HomeScreen from './components/HomeScreen.jsx';
import TimetableScreen from './components/TimetableScreen.jsx';
import SettingsScreen from './components/SettingsScreen.jsx';
import StopPicker from './components/StopPicker.jsx';
import ClassDialog from './components/ClassDialog.jsx';
import ImportDialog from './components/ImportDialog.jsx';
import AlarmToasts from './components/AlarmToasts.jsx';
import { InstallBar, InstallSheet } from './components/InstallGuide.jsx';

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

// '홈 화면에 추가' 안내 한 줄을 닫으면 7일 동안 숨김(이 기기에만 저장)
const DISMISS_KEY = 'kubusai:install:until';
const readDismissed = () => { try { return Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now(); } catch { return false; } };
const writeDismissed = () => { try { localStorage.setItem(DISMISS_KEY, String(Date.now() + 7 * 86400_000)); } catch { /* 저장 불가 환경 */ } };

/**
 * 아이폰 Safari(설치 전)에서: 주소에 '이어받기 코드'를 붙여 둠 → 그 주소 그대로 홈 화면에 추가되면
 * 홈 화면 앱이 처음 열릴 때 같은 사용자(정류장 · 시간표)로 이어짐. 1시간마다 새로 받음(코드는 2시간 · 한 번만)
 */
function useHandoffLink(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const run = () => attachHandoffToUrl().catch(() => {});
    run();
    const id = setInterval(run, 60 * 60_000);
    return () => clearInterval(id);
  }, [enabled]);
}

export default function App({ handoff = null }) {
  const [state, dispatch] = useAppState();
  const sync = useServerSync(state, dispatch, MODE === 'api');
  const [tab, go] = useTab();
  const now = useNow(MODE, state.preview);
  const live = useTrips({ mode: MODE, stop: state.stop, now, previewSource: state.preview.source, previewIncidents: state.preview.incidents || 'all', previewWeather: state.preview.weather || 'rain', previewExplain: state.preview.explain || 'ai' });
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
  // 기기 구분(미리보기는 '기기 보기' 단추로 고른 가상 기기) → 백그라운드 알림 · 아이폰 홈 화면 추가 안내
  const previewKind = state.preview.device || 'pc';
  const info = useMemo(() => (MODE === 'sample' ? previewDevice(previewKind) : deviceInfo()), [previewKind]);
  const push = usePush({ mode: MODE, info });
  useEffect(() => { setPerm(notifyPermission()); }, [push.state]);
  const [guide, setGuide] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => { if (MODE === 'sample') setDismissed(false); }, [previewKind]);
  const hasSetup = Boolean(state.stop || state.classes.length);
  const showBar = tab === 'home' && info.needsInstall && Boolean(state.stop) && !dismissed && !guide;
  const later = () => { writeDismissed(); setDismissed(true); setGuide(false); };
  useHandoffLink(MODE === 'api' && info.needsInstall && sync.status === 'synced' && hasSetup);
  // 홈 화면 앱이 처음 열려 설정을 이어받았으면 잠깐 알림
  const [handoffToast, setHandoffToast] = useState(Boolean(handoff?.claimed));
  useEffect(() => { if (!handoffToast) return undefined; const t = setTimeout(() => setHandoffToast(false), 6000); return () => clearTimeout(t); }, [handoffToast]);

  const [dialog, setDialog] = useState(null);
  const close = useCallback(() => setDialog(null), []);
  const setStop = (stop) => { dispatch({ type: 'setStop', stop }); close(); go('home'); };

  return (
    <div className="min-h-full">
      <Header tab={tab} onTab={go} now={now} />
      {MODE === 'sample' && <PreviewBar preview={state.preview} dispatch={dispatch} />}

      {handoffToast && (
        <div role="status" data-testid="handoff-toast" className="gutter fixed inset-x-0 top-[calc(64px+env(safe-area-inset-top,0px))] z-40 mx-auto max-w-[560px]">
          <p className="flex items-center gap-2 rounded-2xl bg-[#13294B] px-3.5 py-2.5 text-[13.5px] font-semibold leading-snug text-white shadow-pop">
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-[#8FE3AE]" aria-hidden="true"><path d="M5 12.5 10 17 19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {handoff?.hasData ? 'Safari에서 쓰던 정류장 · 시간표를 그대로 가져왔어요' : 'Safari에서 쓰던 설정을 이어받았어요'}
          </p>
        </div>
      )}

      <main className={`gutter mx-auto ${showBar ? 'pb-[calc(156px+env(safe-area-inset-bottom,0px))] md:pb-24' : 'pb-[calc(96px+env(safe-area-inset-bottom,0px))] md:pb-14'} pt-4 short:pt-3 md:pt-8 ${tab === 'timetable' ? 'max-w-[1160px]' : 'max-w-[960px]'}`}>
        {tab === 'home' && (
          <HomeScreen mode={MODE} syncing={sync.status === 'loading'} stop={state.stop} rec={rec} live={live} now={now} nextClass={nextClass} hasClasses={state.classes.length > 0}
            onPickStop={() => setDialog({ type: 'stop' })} onSelectStop={setStop} onGoTimetable={() => go('timetable')} />
        )}
        {tab === 'timetable' && (
          <TimetableScreen mode={MODE} classes={state.classes} sample={state.sampleTimetable} now={now} highlightId={todayClass?.id} onOpen={setDialog}
            onAddCourse={(course, removeIds = []) => {
              const kept = state.classes.filter((c) => !removeIds.includes(c.id));
              const items = courseToClasses(course, { color: colorIndexFor(course.name, kept) });
              dispatch(removeIds.length ? { type: 'swapClasses', removeIds, items } : { type: 'addClasses', items });
            }}
            onRemoveCourse={(courseId) => dispatch({ type: 'deleteCourse', courseId })}
            onRestoreClasses={(classes) => dispatch({ type: 'restoreClasses', classes })} />
        )}
        {tab === 'settings' && (
          <SettingsScreen mode={MODE} state={state} dispatch={dispatch} onPickStop={() => setDialog({ type: 'stop' })}
            perm={perm} onRequestPerm={async () => setPerm(await requestNotifyPermission())} onTestAlarm={alarms.test}
            info={info} push={push} onOpenGuide={() => setGuide(true)} sync={sync.status} live={live} health={health} />
        )}
      </main>

      <TabBar tab={tab} onTab={go} />
      {showBar && <InstallBar info={info} onOpen={() => setGuide(true)} onClose={later} />}
      {guide && <InstallSheet info={info} onClose={() => setGuide(false)} onLater={later} />}
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
