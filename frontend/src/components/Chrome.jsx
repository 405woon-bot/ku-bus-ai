import { toHHMM } from '@shared/time.js';
import { SCENARIOS } from '@shared/transitModel.js';
import { Chip, IconBell, IconBellOff, IconBus, Segmented, SourceTag, inputCls } from './ui.jsx';

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];

/** 상단 바: 서비스 이름 · 구역 바로가기 · 현재 시각 · 알림 상태 */
export function Header({ now, perm, source, reason }) {
  return (
    <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 border-b border-line bg-panel">
      <div className="gutter mx-auto flex h-14 max-w-[1440px] items-center gap-3">
        <a href="#today" className="flex min-w-0 items-center gap-2.5 text-ink">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-primary text-white"><IconBus className="h-5 w-5" /></span>
          <span className="min-w-0">
            <span className="num block text-[20px] font-bold leading-none tracking-tight">KU BUS <span className="text-primary">AI</span></span>
            <span className="hidden truncate text-[11px] text-ink-muted sm:block">시간표 기반 등교 지연 사전 알림</span>
          </span>
        </a>
        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="구역 바로가기">
          {[['#today', '오늘'], ['#timetable', '시간표'], ['#twin', '정체 지도'], ['#settings', '알림 설정']].map(([h, t]) => (
            <a key={h} href={h} className="rounded-lg px-2.5 py-1.5 text-sm font-semibold text-ink-muted hover:bg-surface hover:text-ink">{t}</a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="num whitespace-nowrap text-[16px] font-semibold">{WEEK[now.weekday]} {toHHMM(now.minutes)}</span>
          {now.isDemo && <Chip>데모</Chip>}
          {source && source !== 'api' && <span className="hidden sm:inline-flex"><SourceTag source={source} reason={source === 'mock' ? reason : null} /></span>}
          <a href="#settings" aria-label={perm === 'granted' ? '알림 켜짐 — 설정 보기' : '시스템 알림 꺼짐 — 설정 보기'}
            className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink hover:border-primary-line hover:text-primary">
            {perm === 'granted' ? <IconBell className="h-[18px] w-[18px]" /> : <IconBellOff className="h-[18px] w-[18px]" />}
          </a>
        </div>
      </div>
    </header>
  );
}

/** 데모 시계(단일 HTML 데모 전용): 요일·시각·배속·교통 시나리오를 바꿔 알림을 시험 */
export function DemoBar({ demo, now, plan, dispatch }) {
  const set = (patch, rearm = false) => dispatch({ type: 'setDemo', patch, rearm });
  const here = () => ({ weekday: now.weekday % 7, time: toHHMM(now.minutes) });
  const sel = 'h-8 rounded-lg border border-line bg-panel px-2 text-[13px] outline-none focus:border-primary';
  return (
    <div className="border-b border-dashed border-ink-muted/40 bg-panel">
      <div className="gutter mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-2 py-2 text-[13px]">
        <span className="rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-bold text-white">데모</span>
        <label className="flex items-center gap-1.5 font-semibold"><input type="checkbox" className="h-4 w-4 accent-[#206DEF]" checked={demo.enabled} onChange={(e) => set({ enabled: e.target.checked }, true)} />데모 시계</label>
        {demo.enabled && <>
          <select className={sel} aria-label="데모 요일" value={demo.weekday} onChange={(e) => set({ weekday: +e.target.value, time: toHHMM(now.minutes) }, true)}>{WEEK.slice(0, 5).map((d, i) => <option key={d} value={i}>{d}요일</option>)}</select>
          <input type="time" className={`${inputCls} !h-8 !w-[110px] !text-[13px]`} aria-label="데모 시각" value={demo.time} onChange={(e) => e.target.value && set({ time: e.target.value, weekday: now.weekday % 7 }, true)} />
          <Segmented size="sm" label="배속" value={demo.speed} onChange={(v) => set({ speed: v, ...here() })} options={[1, 10, 60].map((v) => ({ value: v, label: `${v}×` }))} />
          <select className={sel} aria-label="교통 시나리오" value={demo.scenario} onChange={(e) => set({ scenario: e.target.value, ...here() }, true)}>
            {Object.entries(SCENARIOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          {plan && <button type="button" onClick={() => set({ time: toHHMM(plan.alarmAtMin - 1), weekday: now.weekday }, true)} className="h-8 rounded-lg border border-primary px-2.5 font-semibold text-primary hover:bg-primary-soft">출발 알림 1분 전으로</button>}
        </>}
        <span className="ml-auto text-xs text-ink-muted">버스 소요시간·정체는 모의 데이터입니다</span>
      </div>
    </div>
  );
}
