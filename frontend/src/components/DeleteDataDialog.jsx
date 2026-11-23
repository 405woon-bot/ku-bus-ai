// v2.2.5 '내 데이터 모두 삭제' 확인 창(설정 › 내 데이터). 승인한 미리보기(2026-11-23) + '삭제'를 직접 입력해야 버튼이 켜짐.
//   서버 기록을 먼저 지우고, 성공했을 때만 이 기기 값을 지움(lib/wipe.js). 지우는 동안에는 닫거나 다시 누를 수 없음.
//   지우기는 빨간 [모두 삭제] 버튼을 눌렀을 때만 — 입력칸에서 키보드의 완료/Enter를 눌러도 지우지 않음(키보드만 내림).
import { useEffect, useId, useRef, useState } from 'react';
import { Button, IconAlert, IconTrash, Modal, inputCls } from './ui.jsx';
import { deleteMyData } from '../lib/wipe.js';

export const CONFIRM_WORD = '삭제';
/** 입력이 확인 문구와 같은지(앞뒤 공백 · 한글 조합 방식 차이는 무시) */
export const confirmed = (text) => String(text ?? '').normalize('NFC').trim() === CONFIRM_WORD;

export default function DeleteDataDialog({ mode, onClose, run = deleteMyData }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputId = useId();
  const alertRef = useRef(null);
  const running = useRef(false); // 빠르게 두 번 눌러도 한 번만
  const ok = confirmed(text);
  // 실패 안내는 창 맨 위에 나오므로, 아래로 내려 입력하던 작은 화면에서도 보이게 올려 줌
  useEffect(() => { if (err) alertRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [err]);

  async function submit() {
    if (!ok || busy || running.current) return;
    running.current = true; setBusy(true); setErr('');
    let r;
    try { r = await run({ mode }); } catch (e) { r = { ok: false, message: e?.message }; }
    if (!r?.ok) { running.current = false; setBusy(false); setErr(String(r?.message || '서버 응답이 없어요').replace(/[.。]?\s*$/, '.')); }
  }

  return (
    <Modal title="내 데이터 모두 삭제" onClose={onClose} focusFirst={false} canClose={!busy}
      footer={<>
        <Button onClick={onClose} disabled={busy} data-testid="delete-cancel">취소</Button>
        <Button variant="dangerFill" onClick={submit} disabled={!ok || busy} data-testid="delete-confirm">
          {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" /> : <IconTrash className="h-5 w-5" />}
          {busy ? '지우는 중…' : err ? '다시 시도' : '모두 삭제'}
        </Button>
      </>}>
      <div className="grid gap-3" data-testid="delete-dialog" data-state={busy ? 'busy' : err ? 'error' : ok ? 'ready' : 'confirm'}>
        {err && (
          <div ref={alertRef} role="alert" data-testid="delete-error" className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-3 text-[13px] leading-relaxed text-danger">
            <IconAlert className="h-5 w-5 shrink-0" />
            <p><b>서버 기록을 지우지 못했어요.</b> {err} 이 기기 값은 그대로 두었어요. 잠시 뒤 다시 눌러 주세요.</p>
          </div>
        )}
        {mode !== 'api' && (
          <p className="inline-flex h-6 items-center justify-self-start whitespace-nowrap rounded-md border border-dashed border-ink-muted px-2 text-xs font-semibold text-ink-muted">미리보기 · 서버 없음: 이 화면의 예시 값만 지워요</p>
        )}
        <p className="text-[15px] font-bold text-danger">지우면 되돌릴 수 없어요.</p>
        <div className="grid gap-2 rounded-xl border border-line bg-surface px-3.5 py-3 text-[13px] leading-relaxed">
          <div><p className="font-bold">서버에서 지워요</p><p className="text-ink-muted">시간표 · 탑승 정류장 · 출발지 · 설정 · 알림 구독 · 알림 · 도착 기록</p></div>
          <div><p className="font-bold">이 기기에서 지워요</p><p className="text-ink-muted">앱 저장값 · K•CARD+ 캡처 · 사용자 번호(다음부터 새 사용자)</p></div>
          <div><p className="font-bold">지운 뒤에는</p><p className="text-ink-muted">출발 알림이 오지 않고, 앱은 처음 화면으로 돌아가요.</p></div>
        </div>
        <p className="text-xs leading-relaxed text-ink-muted">Safari와 홈 화면 앱처럼 같은 기록을 이어 쓰던 기기가 더 있으면 그 기기에서도 눌러 주세요. 그 기기를 열면 그 기기에 남은 설정이 다시 저장될 수 있어요.</p>
        <label htmlFor={inputId} className="grid gap-1.5">
          <span className="text-[13px] font-semibold">확인하려면 아래 칸에 <b className="text-danger">‘{CONFIRM_WORD}’</b>라고 입력해 주세요</span>
          <input id={inputId} data-testid="delete-input" value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            placeholder={CONFIRM_WORD} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="done"
            className={`${inputCls} ${ok ? '!border-danger ring-[3px] !ring-danger-soft' : ''}`} />
        </label>
      </div>
    </Modal>
  );
}
