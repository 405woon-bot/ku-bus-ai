import { useEffect, useRef, useState } from 'react';
import { Button, FilePickButton, IconIdCard, IconX, Modal } from './ui.jsx';
import { ArrivalFeedback } from './Arrival.jsx';
import { sampleCardFile } from '../lib/kcard.js';

/** 보여 주는 동안 화면 꺼짐 막기(되는 브라우저만 · 다른 앱에 갔다 오면 다시) */
function useWakeLock() {
  useEffect(() => {
    let lock = null, alive = true;
    const free = (l) => { try { l?.release?.()?.catch?.(() => {}); } catch { /* 이미 풀림 */ } };
    const get = async () => {
      try { const l = await navigator.wakeLock?.request?.('screen'); if (alive) lock = l; else free(l); } catch { /* 지원 안 함 · 거부 */ }
    };
    const vis = () => { if (alive && document.visibilityState === 'visible') get(); };
    get();
    document.addEventListener('visibilitychange', vis);
    return () => { alive = false; document.removeEventListener('visibilitychange', vis); free(lock); };
  }, []);
}

/** 검은 전체 화면: 이미지를 최대한 크게(누르면 버튼까지 숨겨 더 크게) + 아래에 도착 기록 결과 */
function FullScreen({ kcard, send, fromPress, onClose }) {
  const [chrome, setChrome] = useState(true);
  const closeRef = useRef(null);
  useWakeLock();
  useEffect(() => {
    const prev = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const html = document.documentElement, old = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); html.style.overflow = old; prev?.focus?.(); };
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="K•CARD+ 캡처 크게 보기" data-testid="kcard-viewer" className="fixed inset-0 z-[60] flex flex-col bg-black text-white">
      {chrome && (
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(12px,env(safe-area-inset-top,0px))]">
          <div className="min-w-0">
            <p className="text-[16px] font-bold">K•CARD+ 캡처</p>
            <p className="truncate text-[12px] text-white/60">이 기기에만 저장 · 밝게 하면 더 잘 보여요</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="닫기" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/15 hover:bg-white/25"><IconX className="h-6 w-6" /></button>
        </div>
      )}
      <button type="button" onClick={() => setChrome((c) => !c)} aria-label={chrome ? '이미지만 크게 보기' : '버튼 다시 보기'} className="relative min-h-0 flex-1">
        <img src={kcard.url} alt="내 K•CARD+ 캡처" draggable="false" className="absolute inset-0 h-full w-full select-none object-contain" />
      </button>
      {chrome && (
        <div className="mx-auto grid w-full max-w-[560px] gap-2 px-4 pb-[max(12px,env(safe-area-inset-bottom,0px))] pt-2">
          {fromPress && <ArrivalFeedback send={send} dark />}
          <button type="button" onClick={onClose} className="h-12 rounded-2xl bg-white/15 text-[16px] font-bold hover:bg-white/25">닫기</button>
        </div>
      )}
    </div>
  );
}

/** 이미지가 없을 때: 도착 기록 결과 + 등록 안내(바로 고르기 · 설정으로 가기) */
function EmptySheet({ mode, kcard, send, fromPress, onClose, onGoSettings }) {
  return (
    <Modal title={fromPress ? '도착했어요' : 'K•CARD+ 캡처'} onClose={onClose} footer={<Button onClick={onClose}>닫기</Button>}>
      <div data-testid="kcard-empty" className="grid gap-3">
        {fromPress && <ArrivalFeedback send={send} />}
        <div className="grid justify-items-center gap-2 rounded-2xl border border-dashed border-primary-line bg-primary-soft/60 px-4 py-5 text-center">
          <IconIdCard className="h-9 w-9 text-primary" />
          <p className="text-[15px] font-bold leading-snug">설정에서 K•CARD+ 캡처를 등록하면<br />도착 시 바로 띄워 드려요</p>
          <p className="text-xs leading-relaxed text-ink-muted">K•CARD+ 앱의 학생증 화면을 캡처해 두세요. 이미지는 이 기기에만 저장돼요(서버로 보내지 않아요).</p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={onGoSettings} data-testid="kcard-go-settings">설정에서 등록하기</Button>
            <FilePickButton variant="default" onFile={kcard.save} busy={kcard.busy} testId="kcard-file-quick">여기서 바로 고르기</FilePickButton>
          </div>
          {mode === 'sample' && <Button size="sm" variant="ghost" onClick={async () => kcard.save(await sampleCardFile())}>예시 이미지로 해 보기(미리보기)</Button>}
          {kcard.error && <p className="text-xs font-semibold text-danger" role="alert">{kcard.error}</p>}
        </div>
      </div>
    </Modal>
  );
}

/**
 * K•CARD+ 캡처 크게 보기. '도착했어요!'를 누르면(fromPress) 아래에 도착 기록 결과도 보여 줌
 * @param {{ mode, kcard: ReturnType<import('../hooks/useKCard.js').useKCard>, send, fromPress: boolean, onClose, onGoSettings }} p
 */
export default function KCardViewer(p) {
  return p.kcard.status === 'ready' && p.kcard.url ? <FullScreen {...p} /> : <EmptySheet {...p} />;
}
