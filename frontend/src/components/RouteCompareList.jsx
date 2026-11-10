import { toHHMM } from '@shared/time.js';
import { routeStatus } from '@shared/departure.js';
import { Card, Chip, RouteBadge, SourceTag } from './ui.jsx';
import { ArrivalLine } from './AlertRouteCard.jsx';

/** 노선별 실시간 소요시간 비교 + 상태 칩(원활 / +N분 지연) */
export default function RouteCompareList({ plan, live, primaryId, onSetPrimary }) {
  const usable = (r) => Number.isFinite(r.liveMin) && Number.isFinite(r.usualMin);
  const rows = plan ? plan.plans : (live?.routes || []).filter((r) => r.enabled !== false && usable(r)).map((r) => {
    const delayMin = Math.max(0, Math.round(r.liveMin - r.usualMin));
    return { ...r, delayMin, status: routeStatus(delayMin) };
  });
  // 실시간 계산에 실패한 노선(예: 승차 정류장 미설정) — 예시 값을 섞지 않고 이유만 보여 줌
  const missing = (live?.routes || []).filter((r) => r.enabled !== false && !usable(r) && r.error);
  const bestId = plan?.plans[0]?.id;
  return (
    <Card title="노선별 실시간 비교" aside={<><SourceTag source={live?.source} reason={live?.reason} />{live?.source === 'seoul' && <span className="hidden sm:inline">30초마다 갱신</span>}</>}>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3">
            <RouteBadge route={r} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-bold">{r.gate} 하차</span>
                <span className="truncate text-xs text-ink-muted">{r.stop}</span>
                {r.id === primaryId && <Chip level="info">주 노선</Chip>}
                {plan && r.id === bestId && r.id !== primaryId && <Chip level="ok">가장 늦게 출발 가능</Chip>}
              </div>
              <div className="text-[13px] text-ink-muted">
                실시간 <b className="num text-[15px] text-ink">{r.liveMin}분</b> · 평소 {r.usualMin}분{plan ? ` · 도보 ${r.walkMin}분` : ''}
              </div>
              <ArrivalLine arrival={r.arrival} />
              {r.stale && <div className="text-[11px] text-warn">서울시 연결이 잠시 끊겨 {r.ageSec}초 전 값을 보여 줘요</div>}
              {r.id !== primaryId && <button type="button" onClick={() => onSetPrimary(r.id)} className="mt-0.5 text-xs font-semibold text-primary hover:text-primary-active">주 노선으로 설정</button>}
            </div>
            <div className="grid justify-items-end gap-1">
              <Chip level={r.status.level}>{r.status.label}</Chip>
              {plan && <div className="text-right"><span className="num text-lg font-bold leading-none">{toHHMM(r.departLiveMin)}</span><span className="ml-1 text-[11px] text-ink-muted">출발</span></div>}
            </div>
          </li>
        ))}
        {missing.map((r) => (
          <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-5 py-3 opacity-80" data-testid="route-missing">
            <RouteBadge route={r} />
            <div className="min-w-0 text-[13px]"><b>{r.gate} 하차 · 실시간 정보 없음</b><div className="text-xs text-warn">{r.error}</div></div>
          </li>
        ))}
      </ul>
      {live?.cause && <p className="border-t border-line px-5 py-2.5 text-xs text-ink-muted">정체 원인 추정: {live.cause} {live.source === 'mock' ? '(예시)' : '(서울시 구간 속도 기준)'}</p>}
    </Card>
  );
}
