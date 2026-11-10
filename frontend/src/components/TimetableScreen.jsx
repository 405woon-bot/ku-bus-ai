import { DAYS, toMin } from '@shared/time.js';
import TimetableGrid, { GRID_END_H, GRID_START_H } from './TimetableGrid.jsx';
import { Button, Card, IconImage, IconPlus, IconText, SampleTag } from './ui.jsx';

/** 시간표: 에브리타임식 주간 표 + 수업 추가 · 텍스트/캡처 이미지로 가져오기 */
export default function TimetableScreen({ classes, sample, now, highlightId, onOpen }) {
  const outside = classes.filter((c) => toMin(c.start) < GRID_START_H * 60 || toMin(c.end) > GRID_END_H * 60);
  return (
    <div className="mx-auto grid w-full max-w-[960px] grid-cols-1 gap-4">
      <Card title="내 시간표" aside={sample ? <SampleTag>예시 시간표</SampleTag> : <span>{classes.length}개 수업</span>}>
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5 sm:px-5">
          <Button variant="primary" size="sm" onClick={() => onOpen({ type: 'class', initial: { start: '09:00', end: '10:15' } })}><IconPlus className="h-4 w-4" />수업 추가</Button>
          <Button size="sm" onClick={() => onOpen({ type: 'import', tab: 'text' })}><IconText className="h-4 w-4" />텍스트로 가져오기</Button>
          <Button size="sm" onClick={() => onOpen({ type: 'import', tab: 'image' })}><IconImage className="h-4 w-4" />캡처로 가져오기</Button>
          <span className="ml-auto hidden text-xs text-ink-muted lg:inline">빈 칸을 누르거나 끌어서 추가 · 수업을 눌러 수정</span>
        </div>
        <div className="px-3 pb-4 pt-3 sm:px-5">
          <TimetableGrid classes={classes} today={now.weekday < 5 ? now.weekday : -1} nowMin={now.minutes} highlightId={highlightId}
            onCreate={(init) => onOpen({ type: 'class', initial: init })} onEdit={(c) => onOpen({ type: 'class', initial: c })} />
          {outside.length > 0 && (
            <p className="mt-2 text-xs text-ink-muted">09~18시 밖 수업: {outside.map((c) => (
              <button key={c.id} type="button" className="mr-2 font-semibold text-primary" onClick={() => onOpen({ type: 'class', initial: c })}>{DAYS[c.day]} {c.start} {c.name}</button>
            ))}</p>
          )}
        </div>
      </Card>
      <p className="px-1 text-xs text-ink-muted">매일 첫 수업 시작 시각을 기준으로 출발 시각을 계산해요.</p>
    </div>
  );
}
