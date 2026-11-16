import { useId, useState } from 'react';
import { appliedOffset, personalLabel, personalText, slackText } from '@shared/arrival.js';
import { toHHMM } from '@shared/time.js';
import { Button, Chip, FilePickButton, IconIdCard } from './ui.jsx';
import { sampleCardFile } from '../lib/kcard.js';

const WD = ['일', '월', '화', '수', '목', '금', '토'];
const two = (n) => String(n).padStart(2, '0');
function dayLabel(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) return '미리보기';
  const d = new Date(`${dateKey}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
}
const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
const savedText = (ms) => { if (!ms) return ''; const d = new Date(ms + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };

/**
 * 설정 · '도착했어요 · K•CARD+': 내 K•CARD+ 캡처 이미지 등록(미리보기 · 바꾸기 · 삭제, 이 기기에만) + 내 걸음 반영 상태
 */
export default function KCardSettings({ mode, kcard, personal, arrivals, onView, onReset, highlight }) {
  const id = useId();
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const has = kcard.status === 'ready' && Boolean(kcard.url);
  const recent = (arrivals || []).slice(-3).reverse();
  const n = appliedOffset(personal?.offsetMin);
  return (
    <section id="kcard" aria-labelledby={id} className="grid scroll-mt-24 grid-cols-1 gap-2">
      <h2 id={id} className="px-1 text-[13px] font-bold text-ink-muted">도착했어요 · K•CARD+</h2>
      <div data-testid="kcard-settings" data-state={kcard.status} className={`divide-y divide-line rounded-2xl border bg-panel shadow-card transition-shadow ${highlight ? 'border-primary ring-[3px] ring-primary-soft' : 'border-line'}`}>
        <div className="px-4 py-3.5">
          <div className="flex items-start gap-3">
            {has
              ? <button type="button" onClick={onView} aria-label="K•CARD+ 캡처 크게 보기" className="h-[88px] w-[52px] shrink-0 overflow-hidden rounded-lg border border-line bg-black"><img src={kcard.url} alt="" className="h-full w-full object-cover object-top" /></button>
              : <div className="grid h-[88px] w-[52px] shrink-0 place-items-center rounded-lg border border-dashed border-ink-muted/50 bg-surface text-ink-muted"><IconIdCard className="h-6 w-6" /></div>}
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">내 K•CARD+ 캡처 이미지 등록</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">‘도착했어요!’를 누르면 바로 크게 띄워요. 이미지는 이 기기에만 저장돼요 — 서버로 보내지 않아요.</p>
              <p className="mt-1 text-xs font-semibold" data-testid="kcard-status">
                {has ? <span className="text-ok">등록됨 · {savedText(kcard.meta?.savedAt)} · {sizeText(kcard.meta?.size || 0)}</span>
                  : kcard.status === 'loading' ? <span className="text-ink-muted">불러오는 중…</span> : <span className="text-ink-muted">아직 등록하지 않았어요</span>}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {has ? (
              <>
                <Button size="sm" onClick={onView}>크게 보기</Button>
                <FilePickButton size="sm" variant="default" onFile={kcard.save} busy={kcard.busy} testId="kcard-file">바꾸기</FilePickButton>
                {confirmDel
                  ? <><Button size="sm" variant="danger" onClick={async () => { setConfirmDel(false); await kcard.remove(); }}>이 기기에서 지우기</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>취소</Button></>
                  : <Button size="sm" variant="ghost" onClick={() => setConfirmDel(true)}>삭제</Button>}
              </>
            ) : <FilePickButton size="sm" onFile={kcard.save} busy={kcard.busy} testId="kcard-file">캡처 이미지 고르기</FilePickButton>}
            {mode === 'sample' && !has && <Button size="sm" variant="ghost" onClick={async () => kcard.save(await sampleCardFile())}>예시 이미지 넣기(미리보기)</Button>}
          </div>
          {kcard.error && <p className="mt-2 text-xs font-semibold text-danger" role="alert">{kcard.error}</p>}
          {has && kcard.meta?.where === 'memory' && <p className="mt-2 text-xs font-semibold text-warn">이 브라우저가 저장을 막아 새로 고치면 지워져요.</p>}
          {has && kcard.meta?.where === 'local' && <p className="mt-2 text-xs text-ink-muted">이 브라우저는 큰 저장소를 쓸 수 없어 조금 줄여 저장했어요.</p>}
          {!has && <p className="mt-2 text-xs leading-relaxed text-ink-muted">사진 앱에서 QR · 학생증 부분만 잘라 등록하면 더 크게 보여요.</p>}
        </div>
        <div className="px-4 py-3.5" data-testid="personal-status">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px] font-semibold">내 걸음 반영</p>
            <Chip level={n ? 'info' : 'muted'}>{personalLabel(personal?.offsetMin)}</Chip>
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{personalText(personal)}{personal?.samples ? ` · 도착 기록 ${personal.samples}번` : ''}</p>
          {recent.length > 0 && (
            <ul className="mt-2 grid gap-1 text-xs text-ink-muted" aria-label="최근 도착 기록">
              {recent.map((r) => (
                <li key={r.key} className="flex flex-wrap gap-x-1.5">
                  <span className="font-semibold text-ink">{dayLabel(r.dateKey)} {toHHMM(Math.floor(r.arriveMin + 1e-9))} 도착</span>
                  <span>{r.name} · {slackText(r.slackMin)}</span><span>→ {personalLabel(r.offsetMin)}</span>
                </li>
              ))}
            </ul>
          )}
          {(personal?.samples > 0 || recent.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {confirmReset
                ? <><Button size="sm" variant="danger" onClick={async () => { setConfirmReset(false); await onReset(); }}>보정 0으로 · 기록 지우기</Button><Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>취소</Button></>
                : <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>처음부터 다시 배우기</Button>}
            </div>
          )}
        </div>
      </div>
      <p className="px-1 text-xs leading-relaxed text-ink-muted">
        버튼은 그날 첫 수업 시작 30분 전부터 15분 뒤까지 홈에 나와요. 목표는 수업 5분 전 도착 — 늦으면 다음부터 일찍(한 번에 최대 3분), 너무 일찍이면 천천히(최대 2분) 맞추고, 수업 5~10분 전 도착은 그대로 둬요(범위 −5 ~ +15분, 한 수업에 한 번).
      </p>
    </section>
  );
}
