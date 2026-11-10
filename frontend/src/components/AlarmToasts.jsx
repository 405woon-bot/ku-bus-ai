import { IconAlert, IconBell, IconX } from './ui.jsx';

/** 화면 알람 팝업(시스템 알림이 막혀 있어도 항상 표시) */
export default function AlarmToasts({ toasts, onDismiss, onSnooze }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(64px+env(safe-area-inset-top,0px))] z-40 flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-[max(20px,env(safe-area-inset-right,0px))]" aria-live="assertive">
      {toasts.map((t) => {
        const tone = t.level === 'danger' ? 'text-danger bg-danger-soft' : t.level === 'warn' ? 'text-warn bg-warn-soft' : 'text-primary bg-primary-soft';
        return (
          <div key={t.id} role="alert" className="toast-in pointer-events-auto w-full max-w-[420px] rounded-2xl border border-line bg-panel p-4 shadow-pop">
            <div className="flex items-start gap-3">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tone}`}>{t.level === 'ok' ? <IconBell /> : <IconAlert />}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold leading-snug">{t.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink">{t.body}</p>
                <p className="mt-1.5 text-[11px] text-ink-muted">{t.system ? '시스템 알림으로도 보냈어요' : '화면 알림 · 브라우저 알림을 허용하면 창이 닫혀 있어도 받을 수 있어요'}</p>
                <div className="mt-2.5 flex gap-2">
                  <button type="button" onClick={() => onDismiss(t.id)} className="h-8 rounded-lg bg-primary px-3 text-[13px] font-semibold text-white hover:bg-primary-active">확인</button>
                  <button type="button" onClick={() => onSnooze(t)} className="h-8 rounded-lg border border-line px-3 text-[13px] font-semibold hover:border-primary-line">5분 뒤 다시</button>
                </div>
              </div>
              <button type="button" onClick={() => onDismiss(t.id)} aria-label="알림 닫기" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-surface"><IconX className="h-4 w-4" /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
