import { DAYS, toHHMM } from '@shared/time.js';
import { IconBus, IconCalendar, IconHome, IconReplay, IconSettings } from './ui.jsx';
import { PREVIEW_SOURCES } from '../hooks/useTrips.js';

export const TABS = [
  { id: 'home', label: '홈', Icon: IconHome },
  { id: 'timetable', label: '시간표', Icon: IconCalendar },
  { id: 'settings', label: '설정', Icon: IconSettings },
];
const dayName = (wd) => (wd < 5 ? DAYS[wd] : wd === 5 ? '토' : '일');

/** 상단 바: 로고 · (넓은 화면) 탭 · 현재 시각 */
export function Header({ tab, onTab, now }) {
  return (
    <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 border-b border-line bg-panel/95 backdrop-blur">
      <div className="gutter mx-auto flex h-14 max-w-[960px] items-center gap-4 short:h-12">
        <a href="#home" onClick={(e) => { e.preventDefault(); onTab('home'); }} className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-primary text-white"><IconBus className="h-5 w-5" /></span>
          KU BUS AI
        </a>
        <nav aria-label="화면" className="ml-4 hidden items-center gap-1 md:flex">
          {TABS.map(({ id, label }) => (
            <a key={id} href={`#${id}`} aria-current={tab === id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onTab(id); }}
              className={`rounded-lg px-3 py-1.5 text-[15px] font-semibold transition-colors ${tab === id ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:text-ink'}`}>{label}</a>
          ))}
        </nav>
        <p className="ml-auto text-[13px] font-semibold text-ink-muted" aria-label="현재 시각">
          {dayName(now.weekday)} <span className="num text-[17px] text-ink">{toHHMM(Math.floor(now.minutes))}</span>
        </p>
      </div>
    </header>
  );
}

/** 휴대폰 하단 탭 바 */
export function TabBar({ tab, onTab }) {
  return (
    <nav aria-label="화면" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur md:hidden">
      <div className="gutter mx-auto grid h-16 max-w-[560px] grid-cols-3">
        {TABS.map(({ id, label, Icon }) => (
          <a key={id} href={`#${id}`} aria-current={tab === id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onTab(id); }}
            className={`flex flex-col items-center justify-center gap-0.5 text-[12px] font-semibold ${tab === id ? 'text-primary' : 'text-ink-muted'}`}>
            <Icon className="h-6 w-6" />{label}
          </a>
        ))}
      </div>
    </nav>
  );
}

const SPEEDS = [1, 10, 60];
/** 미리보기 전용 띠: 샘플 응답 재생 중임을 밝히고, 시계를 빨리 돌려 알림을 확인할 수 있게 합니다. */
export function PreviewBar({ preview, dispatch }) {
  return (
    <div className="border-b border-dashed border-ink-muted/50 bg-surface">
      <div className="gutter mx-auto flex max-w-[960px] flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5 text-[12px] text-ink-muted">
        <p className="min-w-0 flex-1 truncate">
          <span className="font-bold text-ink">미리보기</span> · <span className="sm:hidden">샘플 응답 · 실시간 아님</span>
          <span className="hidden sm:inline">서울시 API 형식의 샘플 응답을 재생해요. 실시간 정보가 아니에요.</span>
        </p>
        <span className="flex shrink-0 items-center gap-1" role="group" aria-label="미리보기 시계 속도">
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={preview.speed === s} onClick={() => dispatch({ type: 'setPreview', patch: { speed: s } })}
              className={`num h-7 min-w-[34px] rounded-md border px-1.5 text-[13px] font-semibold ${preview.speed === s ? 'border-ink bg-ink text-white' : 'border-line bg-panel text-ink hover:border-ink-muted'}`}>{s}×</button>
          ))}
          <button type="button" aria-label="처음부터" title="처음부터" onClick={() => dispatch({ type: 'setPreview', patch: { speed: 1 }, rearm: true })}
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-panel px-1.5 text-[12px] font-semibold text-ink hover:border-ink-muted">
            <IconReplay className="h-4 w-4" /><span className="hidden sm:inline">처음부터</span>
          </button>
        </span>
        {/* 실제 서비스에서 서버 응답에 따라 바뀌는 데이터 출처 배지를 미리 보는 단추 */}
        <span className="flex w-full items-center gap-1 md:w-auto" role="group" aria-label="미리보기 배지 상태">
          <span className="mr-0.5 whitespace-nowrap font-semibold text-ink">배지 보기</span>
          {Object.entries(PREVIEW_SOURCES).map(([id, v]) => (
            <button key={id} type="button" aria-pressed={(preview.source || 'live') === id} onClick={() => dispatch({ type: 'setPreview', patch: { source: id } })}
              className={`h-7 whitespace-nowrap rounded-md border px-2 text-[12px] font-semibold ${(preview.source || 'live') === id ? 'border-ink bg-ink text-white' : 'border-line bg-panel text-ink hover:border-ink-muted'}`}>{v.label}</button>
          ))}
        </span>
      </div>
    </div>
  );
}
