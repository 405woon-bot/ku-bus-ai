/* global __DATA_MODE__ */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildPlan, causeFor, firstClassOf } from '@shared/departure.js';
import { WALK_TABLE } from '@shared/campusData.js';
import { DAYS, toMin } from '@shared/time.js';
import { useAppState } from './hooks/useAppState.js';
import { useNow } from './hooks/useNow.js';
import { useLiveRoutes } from './hooks/useLiveRoutes.js';
import { useAlarms } from './hooks/useAlarms.js';
import { useServerSync } from './hooks/useServerSync.js';
import { notifyPermission } from './lib/platform.js';
import { api } from './lib/api.js';
import { colorIndexFor } from './lib/palette.js';
import { Header, DemoBar } from './components/Chrome.jsx';
import AlertRouteCard from './components/AlertRouteCard.jsx';
import NextClassCard from './components/NextClassCard.jsx';
import RouteCompareList from './components/RouteCompareList.jsx';
import TimetableGrid, { GRID_END_H, GRID_START_H } from './components/TimetableGrid.jsx';
import ClassDialog from './components/ClassDialog.jsx';
import ImportDialog from './components/ImportDialog.jsx';
import WalkTable from './components/WalkTable.jsx';
import AlarmSettings from './components/AlarmSettings.jsx';
import AlarmToasts from './components/AlarmToasts.jsx';
import TwinPanel from './components/TwinPanel.jsx';
import { Button, Card, IconImage, IconPlus, IconText, SampleTag } from './components/ui.jsx';

const MODE = typeof __DATA_MODE__ !== 'undefined' ? __DATA_MODE__ : 'mock';

/** (api 모드) 서버 상태: 실시간 공급자(seoul|mock)·폴백 이유·푸시 — 30초마다 */
function useHealth(enabled) {
  const [h, setH] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const load = () => api.health().then((j) => alive && setH(j)).catch(() => alive && setH({ provider: 'mock', reason: 'server' }));
    load();
    const id = setInterval(load, 30000);
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
  const health = useHealth(MODE === 'api');
  const now = useNow(state.demo);
  const live = useLiveRoutes({ routes: state.routes, now, scenario: state.demo.scenario });

  // 도보시간 표 = 기본(OSM 추정·지정) + 사용자가 고친 값
  const walkTable = useMemo(() => {
    const t = {};
    for (const [b, row] of Object.entries(WALK_TABLE)) t[b] = { ...row, ...(state.walkOverrides[b] || {}) };
    return t;
  }, [state.walkOverrides]);
  const todayClass = useMemo(() => (now.weekday < 5 ? firstClassOf(state.classes, now.weekday) : null), [state.classes, now.weekday]);
  const plan = useMemo(() => buildPlan({
    cls: todayClass, routes: live?.routes, primaryId: state.primaryRouteId, walkTable,
    marginMin: state.settings.marginMin, notifyBeforeMin: state.settings.notifyBeforeMin, cause: causeFor(live, state.primaryRouteId),
  }), [todayClass, live, state.primaryRouteId, walkTable, state.settings]);
  const mockFallback = MODE === 'api' && (plan?.primary?.source ?? live?.source) === 'mock';
  const alarms = useAlarms({ plan, now, fired: state.fired, dispatch, enabled: state.settings.alarms, mockFallback });

  const [dialog, setDialog] = useState(null);
  const close = useCallback(() => setDialog(null), []);
  const myBuildings = useMemo(() => new Set(state.classes.map((c) => c.building).filter(Boolean)), [state.classes]);
  const outside = state.classes.filter((c) => toMin(c.start) < GRID_START_H * 60 || toMin(c.end) > GRID_END_H * 60);
  const walkSrc = plan ? (state.walkOverrides[plan.cls.building]?.[plan.primary.gate] != null ? '수정값' : WALK_TABLE[plan.cls.building]?.src || `기본 5분`) : '';

  return (
    <div className="min-h-full">
      <Header now={now} perm={notifyPermission()} source={plan?.primary?.source ?? live?.source} reason={live?.reason} />
      {MODE === 'mock' && <DemoBar demo={state.demo} now={now} plan={plan} dispatch={dispatch} />}

      <main className="gutter mx-auto grid max-w-[1440px] gap-5 py-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div id="today" className="grid scroll-mt-28 content-start gap-5">
          <AlertRouteCard plan={plan} now={now} live={live} nextDay={nextSchoolDay(state.classes, now.weekday)}
            onUseRoute={(id) => dispatch({ type: 'setPrimary', id })} onPreview={alarms.preview} />
          <NextClassCard plan={plan} walkSrc={walkSrc} />
          <RouteCompareList plan={plan} live={live} primaryId={state.primaryRouteId} onSetPrimary={(id) => dispatch({ type: 'setPrimary', id })} />
        </div>

        <div className="grid content-start gap-5">
          <Card id="timetable" className="scroll-mt-28" title="내 시간표" aside={state.sampleTimetable ? <SampleTag>예시 시간표</SampleTag> : <span>{state.classes.length}개 수업</span>}>
            <div className="flex flex-wrap items-center gap-2 px-5 pt-3.5">
              <Button variant="primary" size="sm" onClick={() => setDialog({ type: 'class', initial: { start: '09:00', end: '10:15' } })}><IconPlus className="h-4 w-4" />수업 추가</Button>
              <Button size="sm" onClick={() => setDialog({ type: 'import', tab: 'text' })}><IconText className="h-4 w-4" />텍스트로 가져오기</Button>
              <Button size="sm" onClick={() => setDialog({ type: 'import', tab: 'image' })}><IconImage className="h-4 w-4" />캡처 이미지로 가져오기</Button>
              <span className="ml-auto hidden text-xs text-ink-muted xl:inline">빈 칸을 누르거나 끌어서 추가 · 수업을 눌러 수정</span>
            </div>
            <div className="px-3 pb-4 pt-3 sm:px-5">
              <TimetableGrid classes={state.classes} today={now.weekday < 5 ? now.weekday : -1} nowMin={now.minutes} highlightId={todayClass?.id}
                onCreate={(init) => setDialog({ type: 'class', initial: init })} onEdit={(c) => setDialog({ type: 'class', initial: c })} />
              {outside.length > 0 && (
                <p className="mt-2 text-xs text-ink-muted">09~18시 밖 수업: {outside.map((c) => (
                  <button key={c.id} type="button" className="mr-2 font-semibold text-primary" onClick={() => setDialog({ type: 'class', initial: c })}>{DAYS[c.day]} {c.start} {c.name}</button>
                ))}</p>
              )}
            </div>
          </Card>
          <div className="grid gap-5 xl:grid-cols-2">
            <TwinPanel live={live} plan={plan} routes={state.routes} nowMin={now.minutes} />
            <WalkTable walkTable={walkTable} overrides={state.walkOverrides} myBuildings={myBuildings}
              onChange={(building, gate, minutes) => dispatch({ type: 'setWalk', building, gate, minutes })} />
          </div>
          <AlarmSettings settings={state.settings} routes={state.routes} primaryId={state.primaryRouteId} log={state.log} dispatch={dispatch} onPreview={alarms.preview}
            serverMode={MODE === 'api'} sync={sync} live={live} health={health} />
        </div>
      </main>

      <footer className="gutter mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-5 text-xs text-ink-muted">
        <span>지도 데이터 © OpenStreetMap contributors (ODbL)</span>
        <span>{MODE === 'mock' ? '버스 소요시간·정체·버스 위치는 예시(모의) 데이터이며 실제 서울시 정보가 아닙니다.' : '실시간 소요시간: 서울특별시 버스 Open API(노선정보·정류소정보, 서버 경유) — 연결할 수 없으면 예시 데이터로 표시'}</span>
        <button type="button" className="ml-auto font-semibold text-ink-muted hover:text-danger" onClick={() => dispatch({ type: 'resetAll' })}>처음 상태로 되돌리기</button>
      </footer>

      <AlarmToasts toasts={alarms.toasts} onDismiss={alarms.dismiss} onSnooze={alarms.snooze} />
      {dialog?.type === 'class' && (
        <ClassDialog initial={dialog.initial} classes={state.classes} walkTable={walkTable} onClose={close}
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
