import { useEffect, useId, useRef } from 'react';
import { routeColor } from '../lib/palette.js';
import { reasonText } from '@shared/liveStatus.js';

/* ── 아이콘(인라인 SVG, 24×24 선 아이콘) ── */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' };
const I = (paths) => function Icon({ className = 'h-5 w-5', ...rest }) { return <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...rest}><g {...P}>{paths}</g></svg>; };
export const IconBus = I(<><rect x="5" y="3" width="14" height="15" rx="3" /><path d="M5 11h14M8 18v2.5M16 18v2.5" /><circle cx="8.6" cy="14.6" r=".8" /><circle cx="15.4" cy="14.6" r=".8" /></>);
export const IconBell = I(<><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>);
export const IconBellOff = I(<><path d="M8.5 5.2A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0M3 3l18 18" /></>);
export const IconWalk = I(<><circle cx="13" cy="4.5" r="1.8" /><path d="m9.5 21 2.2-6.2L14 17v4M8 11.5l2.6-3.4 3.4.4 2 3.3 2.5 1M11.7 14.8 12.6 9" /></>);
export const IconClock = I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IconPlus = I(<path d="M12 5v14M5 12h14" />);
export const IconText = I(<><path d="M5 6h14M5 10.5h14M5 15h9M5 19.5h6" /></>);
export const IconImage = I(<><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 4" /></>);
export const IconCube = I(<><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>);
export const IconMap = I(<><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z" /><path d="M9 4v14M15 6v14" /></>);
export const IconAlert = I(<><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><path d="M12 9.5v4.5M12 16.8v.2" /></>);
export const IconCheck = I(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconX = I(<path d="M6 6l12 12M18 6 6 18" />);
export const IconSwap = I(<><path d="M7 4 4 7l3 3M4 7h12M17 20l3-3-3-3M20 17H8" /></>);
export const IconExternal = I(<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />);
export const IconHome = I(<><path d="m3.5 11 8.5-7 8.5 7" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5.5h4V20" /></>);
export const IconCalendar = I(<><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>);
export const IconPin = I(<><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" /></>);
export const IconSearch = I(<><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>);
export const IconLocate = I(<><circle cx="12" cy="12" r="6.5" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" /><circle cx="12" cy="12" r="2" /></>);
export const IconChevron = I(<path d="m9.5 5.5 6.5 6.5-6.5 6.5" />);
export const IconReplay = I(<><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 4.5v4h4" /></>);
export const IconStop = I(<><rect x="6" y="3" width="12" height="10" rx="2" /><path d="M12 13v8M9 21h6M9 7h6" /></>);
export const IconSettings = I(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>);

/* ── 기본 요소 ── */
export function Card({ title, aside, children, className = '', id, tone }) {
  const hid = useId();
  const toneCls = tone === 'danger' ? 'border-danger/40' : tone === 'warn' ? 'border-warn/40' : 'border-line';
  return (
    <section id={id} aria-labelledby={title ? hid : undefined} className={`min-w-0 rounded-2xl border ${toneCls} bg-panel shadow-card ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 id={hid} className="text-[15px] font-bold">{title}</h2>
          {aside && <div className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = 'default', size = 'md', className = '', children, ...rest }) {
  const v = {
    primary: 'bg-primary text-white border-primary hover:bg-primary-active hover:border-primary-active',
    default: 'bg-panel text-ink border-line hover:border-primary-line hover:text-primary',
    ghost: 'bg-transparent text-ink-muted border-transparent hover:bg-surface hover:text-ink',
    danger: 'bg-panel text-danger border-danger/40 hover:bg-danger-soft',
  }[variant];
  const s = size === 'sm' ? 'h-8 px-2.5 text-[13px] gap-1.5' : 'h-10 px-3.5 text-sm gap-2';
  return <button type="button" className={`inline-flex items-center justify-center whitespace-nowrap rounded-[10px] border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${s} ${v} ${className}`} {...rest}>{children}</button>;
}

const LEVEL = { ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', danger: 'bg-danger-soft text-danger', info: 'bg-primary-soft text-primary-active', muted: 'bg-surface text-ink-muted border border-line' };
export function Chip({ level = 'muted', children, className = '' }) {
  return <span className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-semibold ${LEVEL[level]} ${className}`}>{children}</span>;
}
/** 예시(모의) 데이터 표시 — 점선 테두리로 실제 데이터와 구분 */
export function SampleTag({ children = '예시 데이터' }) {
  return <span className="inline-flex h-6 items-center whitespace-nowrap rounded-md border border-dashed border-ink-muted px-2 text-xs font-semibold text-ink-muted">{children}</span>;
}
/**
 * 데이터 출처 배지: 서울시 실시간(청색 실선) / 예시 데이터(점선) + 예시로 바뀐 이유
 * @param {{ source?: 'seoul'|'mock'|string, reason?: string|null, stale?: boolean }} p
 */
export function SourceTag({ source, reason, stale }) {
  if (source === 'seoul') {
    return (
      <span data-source="seoul" className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-2 text-xs font-bold text-white">
        <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden="true" />서울시 실시간{stale ? ' · 잠시 전 값' : ''}
      </span>
    );
  }
  const why = reason && reason !== 'demo' ? reasonText(reason) : '';
  return (
    <span data-source="mock" title={why ? `실시간 대신 예시 데이터를 보여 주는 이유: ${why}` : '예시 데이터 — 실제 서울시 정보가 아닙니다'}>
      <SampleTag>{why ? `예시 데이터 · ${why}` : '예시 데이터'}</SampleTag>
    </span>
  );
}
export function RouteBadge({ route, size = 'md' }) {
  const s = size === 'lg' ? 'h-9 min-w-[52px] text-lg' : size === 'sm' ? 'h-6 min-w-[38px] text-[13px]' : 'h-7 min-w-[44px] text-[15px]';
  return <span className={`num inline-grid place-items-center rounded-md px-2 font-bold text-white ${s}`} style={{ background: routeColor(route.type) }}>{route.no}</span>;
}

export function Segmented({ value, onChange, options, label, size = 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[10px] border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={`${size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]'} whitespace-nowrap rounded-lg font-semibold transition-colors ${value === o.value ? 'bg-panel text-primary shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 모달 대화상자: Esc·바깥 클릭으로 닫기, 열릴 때 첫 입력에 포커스, 닫히면 원래 버튼으로 포커스 복귀 */
export function Modal({ title, onClose, children, footer, wide = false }) {
  const hid = useId(), ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current?.querySelector('input,select,textarea,button:not([data-close])');
    el?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={hid}
        className={`flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-panel shadow-pop sm:rounded-2xl ${wide ? 'sm:max-w-4xl' : 'sm:max-w-lg'}`}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id={hid} className="text-base font-bold">{title}</h2>
          <button type="button" data-close onClick={onClose} aria-label="닫기" className="grid h-9 w-9 place-items-center rounded-lg text-ink-muted hover:bg-surface hover:text-ink"><IconX /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom,0px))]">{footer}</footer>}
      </div>
    </div>
  );
}

export const Field = ({ label, hint, children, className = '' }) => (
  <label className={`grid gap-1.5 ${className}`}>
    <span className="text-[13px] font-semibold text-ink">{label}</span>
    {children}
    {hint && <span className="text-xs text-ink-muted">{hint}</span>}
  </label>
);
export const inputCls = 'h-10 w-full rounded-[10px] border border-line bg-panel px-3 text-sm outline-none transition focus:border-primary focus:ring-[3px] focus:ring-primary-soft';
