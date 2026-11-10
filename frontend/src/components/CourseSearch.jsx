import { useEffect, useState } from 'react';
import { courseConflicts, courseRoomText, courseTimeText, isCourseAdded } from '@shared/courses.js';
import { SAMPLE_COURSE_META, searchSampleCourses } from '@source';
import { api } from '../lib/api.js';
import { Button, Chip, IconCheck, IconPlus, IconSearch, SampleTag } from './ui.jsx';

const fmtDate = (iso) => { try { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }).format(new Date(iso)); } catch { return ''; } };

/** 강의 목록 출처 한 줄: 몇 학기 · 몇 개 · 언제 받은 목록인지 */
function MetaLine({ mode, meta }) {
  if (mode === 'sample') return <SampleTag>미리보기 샘플 강의 {meta?.count ?? 0}개 · 실제 목록 아님</SampleTag>;
  if (!meta) return null;
  if (meta.available === false) return <span className="text-warn">강의 목록이 아직 없어요</span>;
  return <span>{meta.year}년 {meta.semesterName} 강의 {Number(meta.count || 0).toLocaleString('ko-KR')}개{meta.fetchedAt ? ` · ${fmtDate(meta.fetchedAt)} 기준` : ''}</span>;
}

/**
 * 수업 검색으로 시간표에 넣기(에브리타임처럼).
 * 과목명·교수명·과목번호 → 분반별 요일·시간·강의실 → 눌러서 시간표에 미리 보기(겹치면 빨강) → 추가 / 빼기
 * 강의 목록: 실제 서비스는 서버 /api/courses(courses.json), 미리보기는 샘플 강의
 */
export default function CourseSearch({ mode, classes, selectedId, onSelect, onAdd, onRemove, notice = null, className = '' }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ state: 'idle', courses: [] });
  const [meta, setMeta] = useState(mode === 'sample' ? SAMPLE_COURSE_META : null);

  useEffect(() => {
    if (mode !== 'api') return;
    api.coursesMeta().then(setMeta).catch(() => setMeta({ available: false }));
  }, [mode]);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setRes({ state: 'idle', courses: [] }); return undefined; }
    if (mode === 'sample') { setRes({ state: 'ok', courses: searchSampleCourses(query) }); return undefined; }
    setRes((r) => ({ ...r, state: 'loading' }));
    const t = setTimeout(() => api.searchCourses(query)
      .then((j) => setRes({ state: 'ok', courses: j.courses || [] }))
      .catch((e) => setRes({ state: 'error', courses: [], error: e.message })), 250);
    return () => clearTimeout(t);
  }, [q, mode]);

  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return (
    <section aria-label="수업 검색" className={`min-w-0 rounded-2xl border border-line bg-panel shadow-card ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3.5 sm:px-5">
        <h2 className="text-[15px] font-bold">수업 검색으로 추가</h2>
        <div className="text-xs text-ink-muted" data-testid="course-meta"><MetaLine mode={mode} meta={meta} /></div>
      </header>
      <div className="grid grid-cols-1 gap-3 px-4 py-3.5 sm:px-5">
        <label className="relative block">
          <span className="sr-only">수업 검색</span>
          <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-muted" />
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); onSelect(null); }} placeholder="과목명 · 교수명 · 과목번호 (예: 회로이론)" autoComplete="off"
            className="h-12 w-full rounded-2xl border border-line bg-surface pl-11 pr-4 text-[15px] outline-none transition focus:border-primary focus:bg-panel focus:ring-[3px] focus:ring-primary-soft" />
        </label>

        {notice}
        {res.state === 'idle' && (
          <p className="text-[13px] leading-relaxed text-ink-muted">
            과목을 찾아 누르면 시간표에 미리 보여 드려요. <b className="font-semibold text-ink">추가</b>를 누르면 요일·시간·강의실이 그대로 들어가요.
          </p>
        )}
        {res.state === 'loading' && !res.courses.length && <p className="text-sm text-ink-muted">찾는 중…</p>}
        {res.state === 'error' && <p className="rounded-xl bg-stop-soft px-3 py-2 text-sm text-stop">{res.error}</p>}
        {res.state === 'ok' && !res.courses.length && <p className="text-sm text-ink-muted">맞는 강의가 없어요. 과목명 일부나 교수명으로 찾아보세요.</p>}

        {res.courses.length > 0 && (
          <ul className="-mx-1 grid max-h-[52vh] grid-cols-1 gap-2 overflow-y-auto px-1 pb-1 lg:max-h-[calc(100vh-260px)]" data-testid="course-results">
            {res.courses.map((c) => {
              const added = isCourseAdded(c, classes);
              const conflicts = added ? [] : courseConflicts(c, classes);
              const selected = c.id === selectedId;
              const noTime = !c.times?.length;
              const room = courseRoomText(c);
              return (
                <li key={c.id}>
                  <div role="button" tabIndex={0} aria-pressed={selected} data-testid="course-row"
                    onClick={() => onSelect(selected ? null : c)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected ? null : c); } }}
                    className={`cursor-pointer rounded-2xl border px-3.5 py-3 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-primary-soft ${selected ? 'border-primary bg-primary-soft/60' : 'border-line bg-panel hover:border-primary-line'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 pt-1 text-[15px] font-bold leading-snug">{c.name}<span className="num ml-1.5 text-[13px] font-semibold text-ink-muted">{c.section}분반</span></p>
                      <div className="flex shrink-0 items-center gap-2">
                        {added ? (
                          <>
                            <Chip level="ok"><IconCheck className="h-3.5 w-3.5" />추가됨</Chip>
                            <Button size="sm" variant="ghost" onClick={stop(() => onRemove(c))}>빼기</Button>
                          </>
                        ) : (
                          <Button size="sm" variant={conflicts.length ? 'default' : 'primary'} disabled={noTime} onClick={stop(() => onAdd(c))}
                            className={conflicts.length ? 'border-danger/50 text-danger hover:text-danger' : ''}>
                            <IconPlus className="h-4 w-4" />{conflicts.length ? '바꿔서 추가' : '추가'}
                          </Button>
                        )}
                      </div>
                    </div>
                    <p className="mt-0.5 text-[12px] text-ink-muted">{[c.professor, c.credits != null && `${c.credits}학점`, c.category, c.dayNight === '야간' && '야간'].filter(Boolean).join(' · ')}</p>
                    <p className="mt-1 text-[13px] font-semibold"><span className="num">{courseTimeText(c)}</span>{room && <span className="font-normal text-ink-muted"> · {room}</span>}</p>
                    {conflicts.length > 0 && <p className="mt-1 text-[12px] font-semibold text-danger">겹치는 수업: {conflicts.map((x) => x.name).join(', ')}</p>}
                    {noTime && <p className="mt-1 text-[12px] text-ink-muted">시간이 정해지지 않은 강의(원격 등)라 시간표에 넣을 수 없어요</p>}
                    {c.times?.some((t) => t.day === 6) && <p className="mt-1 text-[12px] text-ink-muted">일요일 시간은 시간표에 넣지 않아요</p>}
                    {selected && !added && !noTime && (
                      <button type="button" className="mt-1.5 text-[13px] font-semibold text-primary lg:hidden"
                        onClick={stop(() => document.querySelector('[data-testid="preview-block"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))}>
                        시간표에서 미리 보기 ↓
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
