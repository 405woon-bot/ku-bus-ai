import { useEffect, useMemo, useRef, useState } from 'react';
import { courseConflicts, courseTimeText, courseToClasses, DAY_NAMES, replaceConflicts } from '@shared/courses.js';
import { toMin } from '@shared/time.js';
import TimetableGrid, { gridRange } from './TimetableGrid.jsx';
import CourseSearch from './CourseSearch.jsx';
import { Button, Card, IconImage, IconPlus, IconText, Modal, SampleTag } from './ui.jsx';

/** 겹치는 과목을 빼고 넣을지 묻기 — 빼는 과목은 모든 요일 수업이 함께 빠짐 */
function ReplaceDialog({ confirm, onCancel, onConfirm }) {
  const { course, groups } = confirm;
  return (
    <Modal title="겹치는 과목을 빼고 추가할까요?" onClose={onCancel}
      footer={<><Button onClick={onCancel}>취소</Button><Button variant="primary" onClick={onConfirm}>빼고 추가</Button></>}>
      <div className="grid gap-3 text-[14px]" data-testid="replace-dialog">
        <p><b>{course.name} {course.section}분반</b><span className="text-ink-muted"> ({courseTimeText(course)})</span>과 시간이 겹치는 과목이 있어요.</p>
        <ul className="grid gap-2">
          {groups.map((g) => (
            <li key={g.key} className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5">
              <p className="font-bold text-danger">{g.name}</p>
              <p className="mt-0.5 text-[13px] text-ink">
                {g.classes.map((c, i) => {
                  const hit = g.overlaps.includes(c);
                  return <span key={c.id}>{i > 0 && ' · '}<span className={hit ? 'font-semibold text-danger' : 'text-ink-muted'}>{DAY_NAMES[c.day]} {c.start}-{c.end}{hit ? ' 겹침' : ''}</span></span>;
                })}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-[13px] text-ink-muted">빼는 과목은 다른 요일 수업까지 함께 빠져요. 바꾼 뒤에도 <b className="text-ink">되돌리기</b>로 원래대로 돌릴 수 있어요.</p>
      </div>
    </Modal>
  );
}

/**
 * 시간표: 수업 검색으로 추가(에브리타임처럼) + 주간 표 + 직접 추가 · 텍스트/캡처 이미지로 가져오기
 * 넓은 화면: 왼쪽 시간표 · 오른쪽 수업 검색 / 휴대폰: 수업 검색 → 시간표
 * 수업 검색으로 넣을 때 시간이 겹치면, 먼저 들어 있던 과목을 빼고 넣을지 묻습니다(시간표에 겹치는 수업이 남지 않게).
 */
export default function TimetableScreen({ mode, classes, sample, now, highlightId, onOpen, onAddCourse, onRemoveCourse, onRestoreClasses }) {
  const [selected, setSelected] = useState(null);
  const [confirm, setConfirm] = useState(null);   // { course, groups, removeIds }
  const [undo, setUndo] = useState(null);         // { prev: 바꾸기 전 시간표, course, names }
  const swapStep = useRef(0);
  // 되돌리기는 바꾼 바로 뒤에만: 바꾸기 자신이 만든 변경은 건너뛰고, 그다음 변경이 생기면 안내를 치움
  useEffect(() => {
    if (!undo) return;
    if (swapStep.current === 1) { swapStep.current = 2; return; }
    setUndo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes]);

  // 고른 강의를 시간표에 점선으로 미리 보기(이미 넣은 강의면 미리 보기 없음, 겹치는 칸은 빨강)
  const preview = useMemo(() => {
    if (!selected || classes.some((c) => c.courseId === selected.id)) return [];
    return courseToClasses(selected).map((p) => ({ ...p, conflict: courseConflicts({ ...selected, times: [p] }, classes).length > 0 }));
  }, [selected, classes]);
  const { startH, endH } = gridRange(classes);
  const outside = classes.filter((c) => c.day > 5 || toMin(c.start) < startH * 60 || toMin(c.end) > endH * 60);

  const add = (course) => {
    const { groups, removeIds } = replaceConflicts(course, classes);
    if (!groups.length) { onAddCourse(course); setSelected(null); return; }
    setConfirm({ course, groups, removeIds });
  };
  const replace = () => {
    const { course, groups, removeIds } = confirm;
    swapStep.current = 1;
    setUndo({ prev: classes, course, names: groups.map((g) => g.name) });
    onAddCourse(course, removeIds);
    setConfirm(null); setSelected(null);
  };
  const notice = undo && (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-go-soft px-3.5 py-2.5 text-[13px] text-go" role="status" data-testid="replace-notice">
      <p className="min-w-0 flex-1"><b>{undo.course.name} {undo.course.section}분반</b>을 넣고, 겹치던 과목({undo.names.join(', ')})은 뺐어요.</p>
      <Button size="sm" onClick={() => { onRestoreClasses(undo.prev); setUndo(null); }}>되돌리기</Button>
    </div>
  );

  return (
    <div className="mx-auto grid w-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      <CourseSearch mode={mode} classes={classes} selectedId={selected?.id} onSelect={setSelected} notice={notice}
        onAdd={add} onRemove={(c) => onRemoveCourse(c.id)}
        className="lg:sticky lg:top-[76px] lg:col-start-2 lg:row-start-1" />
      {confirm && <ReplaceDialog confirm={confirm} onCancel={() => setConfirm(null)} onConfirm={replace} />}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:col-start-1 lg:row-start-1">
        <Card title="내 시간표" aside={sample ? <SampleTag>예시 시간표</SampleTag> : <span>{new Set(classes.map((c) => c.courseId || c.name)).size}개 과목</span>}>
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5 sm:px-5">
            <Button size="sm" onClick={() => onOpen({ type: 'class', initial: { start: '09:00', end: '10:15' } })}><IconPlus className="h-4 w-4" />직접 추가</Button>
            <Button size="sm" onClick={() => onOpen({ type: 'import', tab: 'text' })}><IconText className="h-4 w-4" />텍스트로 가져오기</Button>
            <Button size="sm" onClick={() => onOpen({ type: 'import', tab: 'image' })}><IconImage className="h-4 w-4" />캡처로 가져오기</Button>
            <span className="ml-auto hidden text-xs text-ink-muted xl:inline">빈 칸을 누르거나 끌어서 추가 · 수업을 눌러 수정</span>
          </div>
          {selected && preview.length > 0 && (
            <p className="mx-4 mt-3 rounded-xl bg-primary-soft px-3 py-2 text-[13px] text-primary-active sm:mx-5" data-testid="preview-note">
              <b>{selected.name} {selected.section}분반</b> 미리 보기{preview.some((p) => p.conflict) ? ' · 빨간 칸은 이미 있는 수업과 겹쳐요' : ''}
            </p>
          )}
          <div className="px-3 pb-4 pt-3 sm:px-5">
            <TimetableGrid classes={classes} preview={preview} today={now.weekday < 5 ? now.weekday : -1} nowMin={now.minutes} highlightId={highlightId}
              onCreate={(init) => onOpen({ type: 'class', initial: init })} onEdit={(c) => onOpen({ type: 'class', initial: c })} />
            {outside.length > 0 && (
              <p className="mt-2 text-xs text-ink-muted">표 밖 수업: {outside.map((c) => (
                <button key={c.id} type="button" className="mr-2 font-semibold text-primary" onClick={() => onOpen({ type: 'class', initial: c })}>{DAY_NAMES[c.day]} {c.start} {c.name}</button>
              ))}</p>
            )}
          </div>
        </Card>
        <p className="px-1 text-xs text-ink-muted">매일 첫 수업 시작 시각을 기준으로 출발 시각을 계산해요. 수업 검색의 요일·시간·강의실은 수강신청 사이트의 공개 강좌조회 정보예요.</p>
      </div>
    </div>
  );
}
