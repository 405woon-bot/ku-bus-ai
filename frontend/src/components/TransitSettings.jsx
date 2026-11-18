import { useEffect, useId, useState } from 'react';
import { Button } from './ui.jsx';
import RouteCard from './RouteCard.jsx';
import OriginFinder, { useNextPlan } from './OriginFinder.jsx';

/**
 * 설정 · 출발지(v2.1): 출발 방식 고르기 없이 출발지 하나로.
 * 저장한 경로 + [다른 경로 고르기] / 아직 없으면 출발지 찾기(GPS · 이름 → 추천 경로 3개, 못 찾으면 예전 경로 → 근처 국민대행 정류장 → 안내)
 * 정류장 직행(탑승 정류장 · 걷는 시간 · 직행으로 안내 스위치)은 아래 '고급'에 있음(SettingsScreen)
 */
export default function TransitSettings({ mode, state, dispatch, now, todayClass, nextClass, walkTable, highlight, autoOrigin = null, onDone }) {
  const id = useId();
  const tr = state.transit || {}, route = tr.route;
  const [open, setOpen] = useState(!route);
  // 서버에서 고른 경로를 늦게 받아 왔거나(동기화) 홈의 [바꾸기] · [경로 다시 찾기]로 왔을 때 화면 맞추기
  useEffect(() => { if (route) setOpen(false); }, [tr.savedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (highlight && route) setOpen(true); }, [highlight]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoOrigin) setOpen(true); }, [autoOrigin]);
  const next = useNextPlan({ now, todayClass, nextClass, walkTable, marginMin: state.prefs.marginMin, personalOffsetMin: state.personal?.offsetMin || 0 });
  // 직행 안내 이유: 경로를 못 찾아 근처 정류장으로(retry) / 고급 스위치로 / 정류장만 골라서(경로 없음)
  const directByFallback = tr.mode !== 'transit' && state.stop && tr.retry;
  const directByChoice = route && tr.mode === 'direct' && !directByFallback;
  const directByStop = !route && state.stop && !tr.retry;

  // 출발지 카드(설명 · 저장한 경로 · 찾는 칸). 경로 카드 목록 · 못 찾을 때 안내는 OriginFinder가 이 카드 밖(아래)에
  const card = (controls) => (
    <div data-testid="transit-settings" data-mode={tr.mode} className={`divide-y divide-line rounded-2xl border bg-panel shadow-card ${highlight ? 'border-primary ring-[3px] ring-primary-soft' : 'border-line'}`}>
      <div className="grid gap-1.5 px-4 py-3.5">
        <p className="text-xs leading-relaxed text-ink-muted">집 · 역 같은 출발지에서 지하철 · 버스 환승 경로(ODsay)로 안내해요. 첫 지하철 · 마지막 국민대행 버스는 실시간, 환승마다 3분 여유를 더해요.</p>
        {directByChoice && <p data-testid="transit-direct-note" className="text-xs font-semibold text-warn">아래 ‘고급’에서 정류장 직행을 켜 두어 지금은 {state.stop?.name ? `‘${state.stop.name}’ ` : ''}정류장 직행으로 안내해요.</p>}
        {directByFallback && <p data-testid="transit-fallback-note" className="text-xs font-semibold text-warn">환승 경로를 찾지 못해 가까운 ‘{state.stop.name}’ 정류장 직행으로 안내 중이에요.</p>}
        {directByStop && <p data-testid="transit-direct-note" className="text-xs font-semibold text-warn">지금은 ‘{state.stop.name}’ 정류장 직행으로 안내해요(아래 ‘고급’). 출발지를 정하면 환승 경로로 안내해요.</p>}
        {!route && !state.stop && <p className="text-xs font-semibold text-warn">출발지를 정하면 홈에서 몇 시에 나가면 되는지 알려 드려요.</p>}
      </div>
      {route && !open && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5" data-testid="transit-saved">
          <p className="min-w-0 text-[14px]"><span className="font-semibold">{tr.origin?.name || '출발지'}</span><span className="text-ink-muted"> → 국민대 · </span><span className="font-semibold">{route.title}</span></p>
          <Button size="sm" onClick={() => setOpen(true)}>다른 경로 고르기</Button>
        </div>
      )}
      {controls && (
        <div className="px-4 py-3.5">
          {route && <p className="mb-3 text-[15px] font-semibold">새 출발지</p>}
          {controls}
        </div>
      )}
    </div>
  );

  return (
    <section id="transit" aria-labelledby={id} className="grid scroll-mt-24 grid-cols-1 gap-2">
      <h2 id={id} className="px-1 text-[13px] font-bold text-ink-muted">출발지</h2>
      {open ? (
        <OriginFinder key={autoOrigin ? `auto:${autoOrigin.lat},${autoOrigin.lon}` : 'finder'} mode={mode} state={state} dispatch={dispatch} now={now} todayClass={todayClass} nextClass={nextClass} walkTable={walkTable}
          autoOrigin={autoOrigin} onCancel={route ? () => setOpen(false) : null} wrap={card}
          onDone={(kind) => { if (kind === 'route') setOpen(false); onDone?.(kind); }} />
      ) : card(null)}
      {route && !open && (
        <RouteCard route={route} plan={next.plan(route)} badge="내 경로" classNote={next.note} testId="transit-saved-card" />
      )}
      <p className="px-1 text-xs leading-relaxed text-ink-muted">
        새 경로 검색은 하루 25번까지(ODsay 무료 한도 보호) · 같은 출발지(같은 이름이거나 300m 안)는 30일 동안 저장한 결과를 써요. 한도를 넘으면 예전에 찾아 둔 경로(90일까지) → 가까운 국민대행 정류장 직행 순서로 안내해요.
      </p>
    </section>
  );
}
