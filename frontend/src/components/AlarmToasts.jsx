import { IconAlert, IconBell, IconX } from './ui.jsx';

const TONE = { danger: 'text-stop bg-stop-soft', warn: 'text-caution bg-caution-soft' };

/**
 * 화면 알림(시스템 알림이 막혀 있어도 표시). 한 번에 하나만, 짧게.
 * 휴대폰: 하단 탭 바 바로 위(출발 시각 카드를 가리지 않게) · 넓은 화면: 오른쪽 위
 */
export default function AlarmToasts({ toasts, onDismiss, onSnooze }) {
  const t = toasts[0];
  if (!t) return null;
  return (
    <div aria-live="assertive" className="pointer-events-none fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom,0px))] z-40 flex justify-center px-4 md:bottom-auto md:top-[72px] md:justify-end md:pr-[max(24px,env(safe-area-inset-right,0px))]">
      <div key={t.id} role="alert" className="toast-in pointer-events-auto flex w-full max-w-[420px] items-start gap-3 rounded-2xl border border-line bg-panel py-3 pl-3.5 pr-2 shadow-pop">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${TONE[t.tone] || 'bg-primary-soft text-primary'}`}>{t.tone === 'danger' || t.tone === 'warn' ? <IconAlert /> : <IconBell />}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold leading-snug">{t.title}</p>
          {t.body && <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">{t.body}</p>}
          {t.type !== 'test' && <button type="button" onClick={() => onSnooze(t)} className="mt-1.5 text-[13px] font-semibold text-primary hover:text-primary-active">5분 뒤 다시 알림</button>}
        </div>
        <button type="button" onClick={() => onDismiss(t.id)} aria-label="알림 닫기" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-surface hover:text-ink"><IconX className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
