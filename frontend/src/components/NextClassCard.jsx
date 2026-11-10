import { DAYS, toHHMM } from '@shared/time.js';
import { formulaParts } from '@shared/departure.js';
import { Card, Chip } from './ui.jsx';

const Term = ({ label, value, strong }) => (
  <div className={`grid min-w-[64px] justify-items-center rounded-lg px-2.5 py-1.5 ${strong ? 'bg-primary text-white' : 'bg-surface'}`}>
    <span className={`text-[11px] font-semibold ${strong ? 'text-white/85' : 'text-ink-muted'}`}>{label}</span>
    <span className="num text-lg font-bold leading-tight">{value}</span>
  </div>
);
const Op = ({ children }) => <span className="num px-0.5 text-lg font-bold text-ink-muted">{children}</span>;

/** 오늘 첫 수업 · 목표 학교 도착 시각 · 계산식 */
export default function NextClassCard({ plan, walkSrc }) {
  if (!plan) return null;
  const f = formulaParts(plan), c = plan.cls, p = plan.primary;
  return (
    <Card title="오늘 첫 수업과 출발 계산" aside={<span>{DAYS[c.day]}요일</span>}>
      <div className="grid gap-4 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-bold">{c.name}</div>
            <div className="text-sm text-ink-muted">{c.start}–{c.end} · {c.building} {c.room}</div>
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold text-ink-muted">목표 학교 도착</div>
            <div className="num text-[32px] font-bold leading-none text-primary">{f.target}</div>
            <div className="mt-0.5 text-xs text-ink-muted">{p.gate} 정류장({p.stop}) 하차</div>
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold text-ink-muted">권장 출발 = 수업 시작 − (실시간 버스 + 건물 도보 + 여유)</div>
          <div className="flex flex-wrap items-center gap-1.5" aria-label={`${f.classStart} 빼기 버스 ${f.busMin}분, 도보 ${f.walkMin}분, 여유 ${f.marginMin}분은 ${f.depart}`}>
            <Term label="수업 시작" value={f.classStart} /><Op>−</Op><Op>(</Op>
            <Term label={`${p.no}번 실시간`} value={`${f.busMin}분`} /><Op>+</Op>
            <Term label={`도보 ${p.gate}→건물`} value={`${f.walkMin}분`} /><Op>+</Op>
            <Term label="여유" value={`${f.marginMin}분`} /><Op>)</Op><Op>=</Op>
            <Term label="권장 출발" value={f.depart} strong />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <Chip level={walkSrc === '추정' ? 'muted' : 'info'}>도보시간 {walkSrc}</Chip>
          <span>알림은 {toHHMM(plan.alarmAtMin)}({plan.notifyBeforeMin}분 전)에 울립니다.</span>
        </div>
      </div>
    </Card>
  );
}
