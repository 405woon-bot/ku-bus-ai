import { durationText, hhmm, inkOn, routeSummary } from '@shared/transitPlan.js';
import { IconBus, IconTrain, IconWalk } from './ui.jsx';

// 환승 경로 카드(경로 고르기 목록 · 홈): 위 = 요약(총 소요 · 출발~도착 · 수단별 막대), 아래 = 세로 타임라인(수단 · 정류장/역 · 노선 · 탑승 시각)
const won = (n) => (Number.isFinite(n) && n > 0 ? `${n.toLocaleString('ko-KR')}원` : '');
const stationName = (leg, name) => (leg.kind === 'subway' && name && !/역$/.test(name) ? `${name}역` : name || '');

/** 수단별 비율 막대: 도보(회색 아이콘 + 분) · 간선(파랑) · 지하철(하늘색) · 지선/일반(초록) — 폭은 시간 비율, 좁은 휴대폰에서도 한 줄 */
export function ModeBar({ segments }) {
  const label = segments.map((s) => `${s.label} ${Math.round(s.min)}분`).join(', ');
  const dense = segments.length > 7; // 환승이 많으면 도보 분 · '분' 글자를 줄여 한 줄에
  return (
    <div data-testid="mode-bar" role="img" aria-label={`수단별 시간: ${label}`} className="flex h-7 w-full min-w-0 items-center gap-[2px] rounded-full bg-[#ECEFF3] px-[2px]">
      {segments.map((s, i) => (s.kind === 'walk'
        ? (
          <span key={i} data-kind="walk" className={`flex ${dense ? 'min-w-[20px]' : 'min-w-[28px]'} items-center justify-center gap-px text-[11px] font-semibold text-ink-muted`} style={{ flexGrow: s.min, flexBasis: 0 }}>
            <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[#9AA3AE] text-white"><IconWalk className="h-3 w-3" /></span>
            {!dense && <span className="num">{Math.round(s.min)}</span>}
          </span>
        ) : (
          <span key={i} data-kind={s.kind} className={`flex h-6 ${dense ? 'min-w-[44px]' : 'min-w-[54px]'} items-center overflow-hidden rounded-full`} style={{ flexGrow: s.min, flexBasis: 0, background: s.color }}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 bg-white" style={{ borderColor: s.color, color: s.color }}>
              {s.kind === 'subway' ? <IconTrain className="h-3.5 w-3.5" /> : <IconBus className="h-3.5 w-3.5" />}
            </span>
            <span className="num min-w-0 flex-1 whitespace-nowrap pr-1 text-center text-[12px] font-bold" style={{ color: inkOn(s.color) }}>{Math.round(s.min)}{dense ? '' : '분'}</span>
          </span>
        )))}
    </div>
  );
}

/** 탑승 시각 옆 출처 태그: 실시간 · 배차 간격 예상 · 예상(표준 대기) · 예시(미리보기) */
function SourceBit({ src, sample, minsLeft }) {
  if (src === 'live') {
    return sample
      ? <span className="inline-flex h-5 items-center rounded border border-dashed border-ink-muted px-1.5 text-[11px] font-bold text-ink-muted">예시</span>
      : <span className="inline-flex h-5 items-center gap-1 rounded bg-primary-soft px-1.5 text-[11px] font-bold text-primary-active"><span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />실시간{minsLeft != null && minsLeft >= 0 ? ` · ${minsLeft < 1 ? '곧' : `${Math.round(minsLeft)}분 후`}` : ''}</span>;
  }
  return <span className="inline-flex h-5 items-center rounded bg-surface px-1.5 text-[11px] font-semibold text-ink-muted ring-1 ring-line">{src === 'term' ? '배차 간격 예상' : '예상'}</span>;
}

/**
 * @param {{ route, plan?, badge?: string, liveTag?: 'live'|'std'|'sample'|null, classNote?: string, nowMin?: number, action?: any, testId?: string, sample?: boolean }} p
 *   plan: planTransit 결과(있으면 그 시각들, 없으면 표준 대기로 0시 기준 상대 시각은 감춤)
 */
export default function RouteCard({ route, plan = null, badge = null, liveTag = null, classNote = '', nowMin = null, action = null, testId = 'route-card', sample = false }) {
  const ok = plan?.state === 'ok';
  const sum = routeSummary(route, ok ? plan : null);
  const legsSim = ok ? plan.pick.legs : null;
  const dur = durationText(sum.totalMin), m = /^(?:(\d+)시간)?\s*(?:(\d+)분)?$/.exec(dur) || [];
  const transitRows = [], legs = route.legs;
  const simOf = (i) => legsSim?.find((s) => s.i === i && s.kind !== 'walk') || null;
  let pendingWalk = 0, pendingSafety = 0;
  legs.forEach((leg, i) => {
    if (leg.kind === 'walk') { pendingWalk += leg.min; const w = legsSim?.find((s) => s.i === i && s.kind === 'walk'); pendingSafety += w?.safety || 0; return; }
    const s = simOf(i);
    const extra = !legsSim && transitRows.length ? 3 : 0; // 표준 표시에서도 환승 여유를 밝힘
    transitRows.push({ leg, s, walk: pendingWalk, safety: pendingSafety || extra, first: !transitRows.length });
    pendingWalk = 0; pendingSafety = 0;
  });
  const lastLeg = transitRows.length ? transitRows[transitRows.length - 1].leg : null;
  const tagText = liveTag === 'live' ? '실시간 반영' : liveTag === 'sample' ? '예시 데이터 · 실시간 아님' : liveTag === 'std' ? '예상 · 실시간 전' : '예상';
  return (
    <section data-testid={testId} aria-label={`환승 경로 ${route.title}`} className="min-w-0 rounded-3xl border border-line bg-panel px-5 pb-4 pt-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        {badge ? <span className="text-[14px] font-bold text-primary">{badge}</span> : <span />}
        <span className={`inline-flex h-6 items-center rounded-md px-2 text-[12px] font-semibold ${liveTag === 'live' ? 'bg-primary-soft text-primary-active' : liveTag === 'sample' ? 'border border-dashed border-ink-muted text-ink-muted' : 'bg-surface text-ink-muted ring-1 ring-line'}`}>{tagText}</span>
      </div>
      <p className="mt-1 flex items-baseline gap-0.5 font-bold leading-none tracking-tight" aria-label={`총 ${dur}`}>
        {m[1] && <><span className="num text-[36px]">{m[1]}</span><span className="mr-1.5 text-[18px]">시간</span></>}
        {m[2] && <><span className="num text-[36px]">{m[2]}</span><span className="text-[18px]">분</span></>}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[14px] text-ink-muted">
        {ok && <span className="num text-[15px] font-semibold text-ink">{hhmm(plan.pick.departMin)} - {hhmm(plan.pick.classArriveMin)}</span>}
        {ok && <span aria-hidden="true" className="h-3 w-px bg-line" />}
        <span>환승 {route.transfers}회{won(route.payment) ? ` · ${won(route.payment)}` : ''}</span>
        {classNote && <span className="w-full text-[12.5px]">{classNote}</span>}
      </p>
      <div className="mt-3"><ModeBar segments={sum.segments} /></div>
      <ol className="relative mt-4 grid grid-cols-1" aria-label="타고 갈 순서">
        {transitRows.map(({ leg, s, walk, safety, first }, k) => {
          const bus = leg.kind === 'bus';
          const label = bus ? leg.typeLabel : leg.line;
          const color = leg.color;
          const left = s && nowMin != null ? s.board - nowMin : null;
          return (
            <li key={k} data-kind={leg.kind} className="relative grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 pb-3.5">
              <span aria-hidden="true" className="absolute bottom-0 left-[11px] top-6 w-[2px] bg-[#DDE2E8]" />
              <span className="relative flex items-start gap-1.5 text-[14px] font-bold leading-6" style={{ color: inkOn(color) === '#FFFFFF' ? color : '#4B5565' }}>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full" style={{ background: color, color: inkOn(color) }}>{bus ? <IconBus className="h-4 w-4" /> : <IconTrain className="h-4 w-4" />}</span>
                <span className="truncate">{label}</span>
              </span>
              <div className="min-w-0">
                <p className="truncate text-[15.5px] font-semibold leading-6 text-ink">{stationName(leg, leg.from.name)}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px] text-ink-muted">
                  {bus
                    ? [...new Set([...(s && s.src !== 'std' && s.vehicle ? [s.vehicle] : []), ...(leg.buses?.length ? leg.buses : [leg.no])])].slice(0, 3).map((no) => (
                      <span key={no} className="num inline-flex h-6 items-center rounded-md px-1.5 text-[14px] font-bold" style={{ background: color, color: inkOn(color) }}>{no}</span>
                    ))
                    : <span className="font-semibold text-ink">{leg.way ? `${leg.way} 방면` : leg.line}</span>}
                  {s && <span className="num font-semibold text-ink">{hhmm(s.board)} 탑승</span>}
                  {s && <SourceBit src={s.src} sample={sample} minsLeft={left} />}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  {first ? `출발 → 걸어서 ${Math.round(walk)}분` : `환승 · 걸어서 ${Math.round(walk)}분${safety ? ` + 여유 ${safety}분` : ''}`}
                  {s && s.wait > 0.5 ? ` · 기다림 ${Math.round(s.wait)}분` : ''}{leg.stops ? ` · ${leg.stops}${bus ? '정거장' : '개 역'}` : ''}
                </p>
              </div>
            </li>
          );
        })}
        {lastLeg && (
          <li className="relative grid grid-cols-[76px_minmax(0,1fr)] gap-x-2" data-kind="end">
            <span className="flex items-center gap-1.5 text-[14px] font-bold leading-6 text-ink-muted">
              <span className="grid h-6 w-6 shrink-0 place-items-center"><span className="h-3.5 w-3.5 rounded-full border-[3px] border-ink-muted bg-panel" /></span>하차
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15.5px] font-semibold leading-6 text-ink">{stationName(lastLeg, lastLeg.to.name)}</p>
              {ok && <p className="mt-0.5 text-[12px] text-ink-muted">→ 강의실까지 걸어서 {Math.round(plan.pick.walkInMin)}분 · <span className="num font-semibold text-ink">{hhmm(plan.pick.classArriveMin)}</span> 도착{plan.personalMin ? ` (내 걸음 ${plan.personalMin > 0 ? '+' : '−'}${Math.abs(plan.personalMin)}분 포함)` : ''}</p>}
            </div>
          </li>
        )}
      </ol>
      {action && <div className="mt-3">{action}</div>}
    </section>
  );
}
