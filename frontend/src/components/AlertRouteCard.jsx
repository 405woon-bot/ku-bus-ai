import { toHHMM, DAYS } from '@shared/time.js';
import { Button, Chip, IconAlert, IconBell, IconCheck, IconClock, IconSwap, IconWalk, RouteBadge, SourceTag } from './ui.jsx';

/** 평소 vs 실시간 소요시간 비교 막대 */
export function TravelCompare({ route }) {
  const max = Math.max(route.usualMin, route.liveMin) * 1.08;
  const delayed = route.delayMin >= 2;
  const Row = ({ label, min, cls, extra }) => (
    <div className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3">
      <span className="text-xs font-semibold text-ink-muted">{label}</span>
      <div className="h-3 overflow-hidden rounded-full bg-surface"><div className={`h-full rounded-full ${cls}`} style={{ width: `${(min / max) * 100}%` }} /></div>
      <span className="num w-[86px] text-right text-[15px] font-semibold">{min}분{extra}</span>
    </div>
  );
  return (
    <div className="grid gap-2 rounded-xl border border-line px-4 py-3" aria-label={`${route.no}번 평소 ${route.usualMin}분, 실시간 ${route.liveMin}분`}>
      <Row label="평소" min={route.usualMin} cls="bg-ink-muted/35" />
      <Row label="실시간" min={route.liveMin} cls={delayed ? (route.delayMin >= 5 ? 'bg-danger' : 'bg-warn') : 'bg-ok'}
        extra={delayed ? <span className={`ml-1.5 text-[13px] ${route.delayMin >= 5 ? 'text-danger' : 'text-warn'}`}>+{route.delayMin}</span> : null} />
    </div>
  );
}

function AltRoute({ alt, building, onUse }) {
  const r = alt.route;
  return (
    <div className="grid gap-3 rounded-xl border border-ok/30 bg-ok-soft/60 p-3.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <RouteBadge route={r} />
        <div className="min-w-0">
          <div className="text-sm font-bold">대체 추천 · {r.gate} 방향 {r.no}번</div>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
            <span>실시간 {r.liveMin}분</span>
            <span className="inline-flex items-center gap-0.5"><IconWalk className="h-3.5 w-3.5" />{r.gate}→{building} {r.walkMin}분</span>
          </div>
        </div>
        <div className="text-right">
          <div className="num text-[26px] font-bold leading-none">{toHHMM(r.departLiveMin)}</div>
          <div className="mt-1">{alt.onTime ? <Chip level="ok"><IconCheck className="h-3.5 w-3.5" />정시 출발 가능</Chip> : <Chip level="info">{alt.gainMin}분 늦게 출발 가능</Chip>}</div>
        </div>
      </div>
      <Button size="sm" onClick={onUse} className="justify-self-start"><IconSwap className="h-4 w-4" />{r.no}번을 주 노선으로</Button>
    </div>
  );
}

/**
 * 통합 지연 알림 + 대체 노선 카드
 * props: plan(buildPlan 결과) · now · live(실시간 정보) · nextDay(오늘 수업이 없을 때 다음 등교) · onUseRoute · onPreview
 */
/** 다음 버스 도착(서울시 정류소정보조회 arrmsg1·traTime1) */
export function ArrivalLine({ arrival }) {
  if (!arrival?.first && !arrival?.second) return null;
  const f = arrival.first, s = arrival.second;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-muted" data-testid="arrival">
      <IconClock className="h-4 w-4" />
      <span>다음 버스 <b className="text-ink">{f?.msg || '정보 없음'}</b></span>
      {s?.msg && <span>· 그다음 {s.msg}</span>}
    </p>
  );
}

export default function AlertRouteCard({ plan, now, live, nextDay, onUseRoute, onPreview }) {
  // 배지는 계산에 쓴 주 노선의 출처 기준(서울시 실시간 / 예시 데이터 · 이유)
  const source = plan?.primary?.source ?? live?.source;
  const sourceTag = <SourceTag source={source} reason={source === 'mock' ? live?.reason : null} stale={plan?.primary?.stale} />;
  const missing = plan?.primaryFallback ? (live?.routes || []).find((r) => r.liveMin == null && r.error) : null;
  if (!plan) {
    return (
      <section className="rounded-2xl border border-line bg-panel p-5 shadow-card" aria-live="polite">
        <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-ink-muted">등교 알림</span>{sourceTag}</div>
        <p className="mt-3 text-lg font-bold">오늘({DAYS[now.weekday] ?? '주말'})은 등교할 수업이 없어요.</p>
        {nextDay && <p className="mt-1 text-sm text-ink-muted">다음 등교: {DAYS[nextDay.day]}요일 {nextDay.start} {nextDay.name} · {nextDay.building}</p>}
      </section>
    );
  }
  const p = plan.primary;
  const started = now.minutes >= plan.classStartMin;
  const left = Math.ceil(plan.recommendedDepartMin - now.minutes);
  const tone = plan.delayed ? (plan.level === 'danger' ? 'danger' : 'warn') : 'ok';
  const band = { danger: 'bg-danger-soft text-danger', warn: 'bg-warn-soft text-warn', ok: 'bg-ok-soft text-ok' }[tone];
  const border = { danger: 'border-danger/35', warn: 'border-warn/35', ok: 'border-line' }[tone];
  return (
    <section className={`overflow-hidden rounded-2xl border ${border} bg-panel shadow-card`} aria-live="polite" aria-label="등교 지연 알림">
      <div className={`flex flex-wrap items-center gap-2 px-5 py-2.5 ${band}`}>
        {plan.delayed ? <IconAlert className="h-5 w-5" /> : <IconCheck className="h-5 w-5" />}
        <span className="text-sm font-bold">{plan.delayed ? `지연 알림 · ${p.no}번 +${p.delayMin}분` : `정상 운행 · ${p.no}번`}</span>
        <span className="ml-auto flex items-center gap-2 text-xs font-semibold">{toHHMM(live.updatedMin ?? now.minutes)} 기준 {sourceTag}</span>
      </div>
      <div className="grid gap-4 px-5 pb-5 pt-4">
        <p className="text-[17px] font-bold leading-relaxed">{started ? `${plan.cls.name} 수업이 이미 시작됐어요. 내일 등교 계획은 시간표 기준으로 다시 계산됩니다.` : plan.message}</p>
        {!started && (
          <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
            <div>
              <div className="text-xs font-semibold text-ink-muted">권장 출발</div>
              <div className="num text-[52px] font-bold leading-[0.95] tracking-tight">{toHHMM(plan.recommendedDepartMin)}</div>
            </div>
            <div className="grid gap-1 pb-1 text-sm">
              <span className={`font-bold ${left <= 0 ? 'text-danger' : left <= plan.notifyBeforeMin ? 'text-warn' : 'text-ink'}`}>{left > 0 ? `출발까지 ${left}분` : '권장 출발 시각이 지났어요'}</span>
              <span className="text-xs text-ink-muted">알림 {toHHMM(plan.alarmAtMin)} ({plan.notifyBeforeMin}분 전) · 목표 하차 {toHHMM(plan.targetArrivalMin)}</span>
            </div>
          </div>
        )}
        {missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">주 노선 {missing.no}번은 실시간 정보가 없어({missing.error}) {p.no}번 기준으로 계산했어요.</p>}
        <TravelCompare route={p} />
        <ArrivalLine arrival={p.arrival} />
        {plan.alt && plan.delayed && !started && <AltRoute alt={plan.alt} building={plan.cls.building} onUse={() => onUseRoute(plan.alt.route.id)} />}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onPreview}><IconBell className="h-4 w-4" />알림 미리 보기</Button>
        </div>
      </div>
    </section>
  );
}
