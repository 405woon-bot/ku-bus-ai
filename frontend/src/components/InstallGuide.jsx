import { useEffect, useId, useRef, useState } from 'react';

// 아이폰 '홈 화면에 추가' 안내: 홈 화면 아래쪽 한 줄(떠 있음) + '방법 보기' 시트.
// 아이폰은 홈 화면에 추가한 앱에서만 웹 푸시를 받을 수 있어요(iOS 16.4 이상). 앱 안의 브라우저(카카오톡 등)는 Safari로 열도록 안내.

const G = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const IconX = ({ className = 'h-3.5 w-3.5' }) => <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><g {...G} strokeWidth={3}><path d="M6 6l12 12M18 6 6 18" /></g></svg>;
const IconDots = ({ className = 'h-3.5 w-3.5' }) => <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>;
const IconShare = ({ className = 'h-3.5 w-3.5' }) => <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><g {...G}><path d="M12 3v12M8 7l4-4 4 4" /><path d="M7 11H5v10h14V11h-2" /></g></svg>;
const IconAdd = ({ className = 'h-3.5 w-3.5' }) => <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><g {...G}><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8v8M8 12h8" /></g></svg>;
const IconCheck = ({ className = 'h-4 w-4' }) => <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><g {...G} strokeWidth={2.4}><path d="M5 12.5 10 17 19 7" /></g></svg>;
const Glyph = ({ children, label }) => <span role="img" aria-label={label} className="mx-0.5 inline-grid h-[22px] w-[22px] place-items-center rounded-md border border-[#D6D6D6] bg-[#F7F7F7] align-[-6px] text-ink">{children}</span>;

const notSafari = (info) => info.browser !== 'safari';

/** 홈 화면 아래쪽(탭 바 위)에 떠 있는 한 줄 — 화면 배치를 밀지 않음 */
export function InstallBar({ info, onOpen, onClose }) {
  return (
    <div role="region" aria-label="홈 화면에 추가 안내" data-testid="install-bar"
      className="fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom,0px))] z-20 px-2.5 md:bottom-6">
      <div className="mx-auto flex max-w-[540px] items-center gap-2 rounded-2xl border border-primary-line bg-panel py-2 pl-3.5 pr-1.5 shadow-pop">
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-bold">{notSafari(info) ? 'Safari로 열면 알림을 받을 수 있어요' : '홈 화면에 추가하고 알림 받기'}</span>
        <button type="button" onClick={onOpen} className="h-8 shrink-0 rounded-[10px] bg-primary px-3 text-[13px] font-bold text-white hover:bg-primary-active">방법 보기</button>
        <button type="button" aria-label="안내 닫기(7일 동안)" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-surface"><IconX /></button>
      </div>
    </div>
  );
}

function Step({ n, children }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-[13px] font-bold text-white">{n}</span>
      <span className="min-w-0 flex-1 text-[14px] leading-[1.45]">{children}</span>
    </li>
  );
}
const Mini = ({ children }) => <span className="mt-1.5 flex h-9 items-center justify-between gap-2 rounded-[10px] bg-[#F4F4F6] px-3 text-[13.5px]">{children}</span>;

/** 주소 복사(앱 안의 브라우저 → Safari) */
function CopyUrl() {
  const [done, setDone] = useState(false);
  const copy = async () => {
    const url = window.location.href;
    try { await navigator.clipboard.writeText(url); setDone(true); } catch {
      try { const t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); setDone(true); } catch { setDone(false); }
    }
  };
  return (
    <button type="button" onClick={copy} className="mt-1.5 inline-flex h-9 items-center rounded-[10px] border border-line bg-panel px-3 text-[13.5px] font-bold text-primary">
      {done ? '복사했어요 · Safari 주소창에 붙여 넣기' : '주소 복사'}
    </button>
  );
}

/**
 * '방법 보기' 시트: Safari 버전에 맞춰 첫 단계를 바꿈(iOS 26 ⋯ → 공유 / iOS 18 이하 공유 버튼), 앱 안의 브라우저면 Safari로 열기 안내
 * @param {{ info: object, onClose: () => void, onLater: () => void }} p
 */
export function InstallSheet({ info, onClose, onLater }) {
  const titleId = useId();
  const okRef = useRef(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const other = notSafari(info);
  const where = info.iPad ? '위쪽' : '아래';
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="install-sheet">
      <div className="absolute inset-0 bg-[#10151F]/45" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-x-0 bottom-0 mx-auto max-h-[92vh] max-w-[560px] overflow-y-auto rounded-t-[22px] bg-panel px-[18px] pb-[calc(14px+env(safe-area-inset-bottom,0px))] pt-2 shadow-pop">
        <div className="mx-auto mb-2.5 h-[5px] w-10 rounded bg-line" aria-hidden="true" />
        <h2 id={titleId} className="text-[18px] font-bold tracking-tight">{other ? 'Safari로 열어 주세요' : '홈 화면에 추가하기'}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          {other
            ? `${info.inAppName ? `${info.inAppName} 안의 브라우저` : '이 브라우저'}에서는 홈 화면에 추가할 수 없어요. 아이폰은 Safari로 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요.`
            : '아이폰은 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요(iOS 16.4 이상). 1분이면 돼요.'}
        </p>
        <ol className="mt-3 grid gap-2.5" data-testid="install-steps">
          {other ? (
            <>
              <Step n={1}>화면의 <Glyph label="더 보기"><IconDots /></Glyph> 또는 <Glyph label="공유"><IconShare /></Glyph> 메뉴에서 <b>Safari로 열기</b>(다른 브라우저로 열기)</Step>
              <Step n={2}>메뉴가 없으면 주소를 복사해 Safari 주소창에 붙여 넣기<br /><CopyUrl /></Step>
              <Step n={3}>Safari에서 <b>공유 → 홈 화면에 추가</b>, 홈 화면의 <b>KU BUS</b> 아이콘으로 열기</Step>
            </>
          ) : (
            <>
              <Step n={1}>
                {info.newShare
                  ? <>{where} 주소창 오른쪽 <Glyph label="더 보기"><IconDots /></Glyph> → <b>공유</b><span className="mt-px block text-[12px] text-ink-muted">공유 버튼 <Glyph label="공유"><IconShare /></Glyph>이 바로 보이면 그걸 눌러도 돼요</span></>
                  : <>{info.iPad ? '위쪽 주소창 오른쪽' : '아래쪽 가운데'} 공유 버튼 <Glyph label="공유"><IconShare /></Glyph> 누르기</>}
              </Step>
              <Step n={2}>
                <b>홈 화면에 추가</b> 누르기 <span className="text-[12px] text-ink-muted">(안 보이면 목록을 위로 밀기)</span>
                <Mini><span>홈 화면에 추가</span><Glyph label="추가"><IconAdd /></Glyph></Mini>
              </Step>
              <Step n={3}>
                {info.newShare
                  ? <><b>웹 앱으로 열기</b>가 켜져 있는지 보고 <b>추가</b><Mini><span>웹 앱으로 열기</span><span className="relative h-[22px] w-[38px] shrink-0 rounded-full bg-[#34C759]" aria-label="켜짐"><span className="absolute right-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white" /></span></Mini></>
                  : <>오른쪽 위 <b>추가</b> 누르기</>}
              </Step>
              <Step n={4}>홈 화면의 <b>KU BUS</b> 아이콘으로 열고 → 설정에서 <b>알림 켜기</b></Step>
            </>
          )}
        </ol>
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-go-soft px-3 py-2 text-[12.5px] font-semibold leading-snug text-go">
          <IconCheck className="h-4 w-4 shrink-0" />정류장 · 시간표 · 설정은 홈 화면 앱으로 그대로 이어져요
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onLater} className="h-[42px] flex-1 rounded-xl border border-line bg-surface text-[15px] font-bold text-[#555]">다음에 할게요</button>
          <button type="button" ref={okRef} onClick={onClose} className="h-[42px] flex-1 rounded-xl bg-primary text-[15px] font-bold text-white">알겠어요</button>
        </div>
        {!other && !info.iPad && (
          <p className={`mt-2.5 flex ${info.newShare ? 'justify-end' : 'justify-center'}`} aria-hidden="true">
            <span className="relative rounded-lg bg-stop-dot px-2.5 py-0.5 text-[12px] font-bold text-white after:absolute after:-bottom-1.5 after:right-4 after:border-x-[6px] after:border-t-[6px] after:border-x-transparent after:border-t-stop-dot">
              {info.newShare ? '아래 Safari 막대의 ⋯' : '아래 Safari 막대의 공유 버튼'}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
