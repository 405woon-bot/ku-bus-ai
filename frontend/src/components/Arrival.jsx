import { useState } from 'react';
import { toHHMM } from '@shared/time.js';
import { appliedOffset, arrivalFeedback, personalLabel, slackText } from '@shared/arrival.js';
import { Button, IconAlert, IconArrive, IconCheck, IconIdCard } from './ui.jsx';

const VERDICT_TEXT = { late: '늦었어요', tight: '조금 빠듯했어요', good: '딱 좋아요', early: '넉넉했어요' };
const VERDICT_TONE = { late: 'text-stop', tight: 'text-caution', good: 'text-go', early: 'text-ink-muted' };
const two = (n) => String(n).padStart(2, '0');
/** 서울 시각 HH:MM (ms) — 브라우저 시간대와 관계없이 */
export const kstHHMM = (ms) => { const d = new Date(ms + 9 * 3600_000); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };

/** 내 걸음 반영 짧은 설명 */
export function personalShort(offsetMin) {
  const n = appliedOffset(offsetMin);
  return n > 0 ? `${n}분 일찍 도착하도록 안내해요` : n < 0 ? `${-n}분 덜 서둘러도 되게 안내해요` : '보정 없이 안내해요';
}

/** [도착했어요!] — 오늘 첫 수업 시작 30분 전 ~ 15분 뒤 */
export function ArriveButton({ onClick, busy, size = 'md', className = '' }) {
  const lg = size === 'lg';
  return (
    <button type="button" data-testid="arrive-button" onClick={onClick} disabled={busy} aria-busy={busy || undefined}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-primary font-bold text-white shadow-[0_2px_8px_rgba(32,109,239,.32)] transition-colors hover:bg-primary-active disabled:opacity-70 ${lg ? 'h-12 px-5 text-[16px]' : 'h-8 px-3 text-[14px]'} ${className}`}>
      <IconArrive className={lg ? 'h-5 w-5' : 'h-[17px] w-[17px]'} />{busy ? '기록 중…' : '도착했어요!'}
    </button>
  );
}

/**
 * 도착 기록 뒤 ~ 수업이 끝날 때까지 홈에: 기록 · K•CARD+ 다시 보기 · 내 걸음 반영 (보내는 중이면 그 표시)
 * @param {{ record?, pendingAt?: number, cls, personal, kcardReady, canUndo, onView, onUndo }} p
 */
export function ArrivedCard({ record, pendingAt, cls, personal, kcardReady, canUndo, onView, onUndo }) {
  const [confirm, setConfirm] = useState(false);
  const name = record?.name || cls?.name || '';
  const place = cls?.building ? ` · ${cls.building}${cls.room ? ` ${cls.room}` : ''}` : '';
  return (
    <section aria-label="도착 기록" data-testid="arrived-card" data-state={record ? 'saved' : 'sending'} className="grid grid-cols-1 gap-3 rounded-3xl border border-line bg-panel px-5 pb-5 pt-4 shadow-card sm:px-6">
      <div className="flex items-center justify-between gap-3">
        {record
          ? <span className="flex items-center gap-1.5 text-[13px] font-bold text-go"><IconCheck className="h-4 w-4" />도착 기록 완료</span>
          : <span className="flex items-center gap-1.5 text-[13px] font-bold text-caution"><span className="h-2 w-2 animate-pulse rounded-full bg-caution-dot" aria-hidden="true" />도착 기록 보내는 중</span>}
        <span className="text-[13px] font-semibold text-ink-muted">
          <span className="num text-[16px] text-ink">{record ? toHHMM(Math.floor(record.arriveMin + 1e-9)) : kstHHMM(pendingAt)}</span> 도착
        </span>
      </div>
      <div>
        <p className="text-[22px] font-bold leading-tight tracking-[-0.01em] sm:text-[24px]">{name} 수업에 도착했어요</p>
        <p className="mt-1 text-[14px] text-ink-muted">
          {record
            ? <>{slackText(record.slackMin)} · <b className={`font-semibold ${VERDICT_TONE[record.verdict] || ''}`}>{VERDICT_TEXT[record.verdict]}</b>{place}</>
            : '연결이 안 되면 이 기기에 두었다가 자동으로 다시 보내요'}
        </p>
      </div>
      <Button variant="primary" data-testid="kcard-open" className="h-12 w-full rounded-2xl text-[16px]" onClick={onView}>
        <IconIdCard className="h-5 w-5" />{kcardReady ? 'K•CARD+ 다시 보기' : 'K•CARD+ 캡처 등록하기'}
      </Button>
      {record && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line pt-3">
          <p className="min-w-0 text-[13px] leading-snug text-ink-muted" data-testid="personal-line">
            <b className="font-semibold text-ink">내 걸음 반영 {personalLabel(personal?.offsetMin)}</b> · {personalShort(personal?.offsetMin)}
          </p>
          {canUndo && (confirm
            ? <span className="flex shrink-0 items-center gap-1.5"><Button size="sm" variant="danger" onClick={() => { setConfirm(false); onUndo(); }}>기록 취소하기</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>아니요</Button></span>
            : <button type="button" onClick={() => setConfirm(true)} className="shrink-0 text-[13px] font-semibold text-ink-muted underline underline-offset-2 hover:text-ink">잘못 눌렀어요</button>)}
        </div>
      )}
    </section>
  );
}

/** 버스 정보를 못 받는 중(오류 · 노선 없음 · 불러오는 중)에도 버튼 시간이면 보이는 한 줄 카드 */
export function ArrivalPrompt({ cls, busy, onArrive }) {
  return (
    <section aria-label="도착 기록" data-testid="arrival-prompt" className="flex items-center justify-between gap-3 rounded-3xl border border-line bg-panel px-5 py-4 shadow-card">
      <div className="min-w-0">
        <p className="text-[16px] font-bold">강의실에 도착했나요?</p>
        <p className="truncate text-[13px] text-ink-muted">{cls.name} {cls.start} 시작 · 누르면 K•CARD+를 바로 띄워요</p>
      </div>
      <ArriveButton onClick={onArrive} busy={busy} />
    </section>
  );
}

/**
 * 버튼을 누른 뒤 피드백(K•CARD+ 화면 아래 · 이미지가 없을 때 안내 창)
 * @param {{ send: {status, record?, message?}, dark?: boolean }} p
 */
export function ArrivalFeedback({ send, dark = false }) {
  if (!send) return null;
  const muted = dark ? 'text-white/70' : 'text-ink-muted';
  const chip = dark ? 'bg-white/15 text-white' : 'bg-primary-soft text-primary-active';
  const box = `grid gap-1 rounded-2xl px-4 py-3 ${dark ? 'bg-white/10' : 'bg-surface border border-line'}`;
  if (send.status === 'saving') return <div role="status" data-testid="arrival-feedback" data-status="saving" className={box}><p className="text-[15px] font-bold">도착 기록 중…</p></div>;
  if (send.status === 'pending' || send.status === 'error') {
    return (
      <div role="status" data-testid="arrival-feedback" data-status={send.status} className={box}>
        <p className={`flex items-center gap-1.5 text-[15px] font-bold ${dark ? 'text-[#FFD66B]' : send.status === 'error' ? 'text-danger' : 'text-warn'}`}>
          <IconAlert className="h-4 w-4 shrink-0" />{send.status === 'pending' ? '도착 기록을 아직 못 보냈어요' : '도착을 기록하지 못했어요'}
        </p>
        <p className={`text-[13px] ${muted}`}>{send.status === 'pending' ? '연결이 불안정해요. 이 기기에 두었다가 연결되면 누른 시각 그대로 자동으로 보내요.' : send.message}</p>
      </div>
    );
  }
  const r = send.record;
  if (!r) return null;
  if (send.status === 'already') {
    return (
      <div role="status" data-testid="arrival-feedback" data-status="already" className={box}>
        <p className="text-[15px] font-bold">오늘은 이미 {toHHMM(Math.floor(r.arriveMin + 1e-9))}에 도착을 기록했어요</p>
        <p className={`text-[13px] ${muted}`}>한 수업에 한 번만 배워요 · <span className={`inline-flex rounded-md px-1.5 font-semibold ${chip}`}>내 걸음 반영 {personalLabel(r.offsetMin)}</span></p>
      </div>
    );
  }
  const fb = arrivalFeedback(r);
  return (
    <div role="status" data-testid="arrival-feedback" data-status="done" className={box}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-[16px] font-bold">
        <span className="flex items-center gap-1.5"><IconCheck className={`h-[18px] w-[18px] self-center ${dark ? 'text-[#8FE3AE]' : 'text-go'}`} />{fb.title}</span>
        <span className={`text-[13px] font-semibold ${muted}`}>{fb.when} · {fb.verdict}</span>
      </p>
      <p className="text-[14px] font-semibold leading-snug">{fb.change}</p>
      <p><span data-testid="arrival-status" className={`inline-flex h-6 items-center rounded-md px-2 text-[12.5px] font-bold ${chip}`}>{fb.status}</span></p>
    </div>
  );
}
