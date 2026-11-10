import { useState } from 'react';
import { DAYS, toHHMM, toMin } from '@shared/time.js';
import { BUILDINGS, DEFAULT_WALK_MIN } from '@shared/campusData.js';
import { PERIODS } from '@shared/parseTimetableText.js';
import { COURSE_COLORS, colorIndexFor } from '../lib/palette.js';
import { Button, Field, Modal, Segmented, inputCls } from './ui.jsx';

const SORTED = [...BUILDINGS].sort((a, b) => a.name.localeCompare(b.name, 'ko'));

/** 수업 추가/수정 대화상자: 과목명 · 요일 · 시각 또는 교시 · 건물/강의실 · 색 */
export default function ClassDialog({ initial, classes, walkTable, onSave, onDelete, onClose }) {
  const editing = Boolean(initial.id);
  const known = !initial.building || BUILDINGS.some((b) => b.name === initial.building);
  const [name, setName] = useState(initial.name || '');
  const [days, setDays] = useState(initial.day != null ? [initial.day] : []);
  const [mode, setMode] = useState('time');
  const [start, setStart] = useState(initial.start || '09:00');
  const [end, setEnd] = useState(initial.end || '10:15');
  const [p1, setP1] = useState(1), [p2, setP2] = useState(2);
  const [building, setBuilding] = useState(known ? (initial.building || '') : '__custom');
  const [custom, setCustom] = useState(known ? '' : initial.building);
  const [room, setRoom] = useState(initial.room || '');
  const [color, setColor] = useState(initial.color ?? colorIndexFor(initial.name || '', classes));
  const [touched, setTouched] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const bName = building === '__custom' ? custom.trim() : building;
  const times = mode === 'time' ? { start, end } : { start: toHHMM(PERIODS[p1 - 1].start), end: toHHMM(PERIODS[Math.max(p1, p2) - 1].end) };
  const errors = [];
  if (!name.trim()) errors.push('과목명을 입력하세요.');
  if (!days.length) errors.push('요일을 하나 이상 고르세요.');
  if (!(toMin(times.end) > toMin(times.start))) errors.push('종료 시각은 시작 시각보다 늦어야 해요.');
  if (!bName) errors.push('강의 건물을 고르세요.');
  const overlaps = classes.filter((c) => c.id !== initial.id && days.includes(c.day) && toMin(c.start) < toMin(times.end) && toMin(times.start) < toMin(c.end));
  const walk = walkTable[bName];

  const toggleDay = (d) => setDays((ds) => (editing ? [d] : ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d].sort()));
  const save = () => {
    setTouched(true);
    if (errors.length) return;
    onSave(days.map((day) => ({ ...(editing ? { id: initial.id } : {}), name: name.trim(), day, ...times, building: bName, room: room.trim(), color })));
  };

  return (
    <Modal title={editing ? '수업 수정' : '수업 추가'} onClose={onClose}
      footer={<>
        {editing && (confirmDel
          ? <Button variant="danger" onClick={() => onDelete(initial.id)}>정말 삭제</Button>
          : <Button variant="ghost" className="mr-auto text-danger hover:text-danger" onClick={() => setConfirmDel(true)}>삭제</Button>)}
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" onClick={save}>{editing ? '저장' : days.length > 1 ? `${days.length}개 추가` : '추가'}</Button>
      </>}>
      <div className="grid gap-4">
        <Field label="과목명"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 자료구조" maxLength={40} /></Field>
        <div className="grid gap-1.5">
          <span className="text-[13px] font-semibold">요일{!editing && <span className="ml-1 font-normal text-ink-muted">(여러 개 선택 가능)</span>}</span>
          <div className="flex gap-1.5" role="group" aria-label="요일">
            {DAYS.map((d, i) => (
              <button key={d} type="button" aria-pressed={days.includes(i)} onClick={() => toggleDay(i)}
                className={`h-10 w-11 rounded-[10px] border text-sm font-bold transition-colors ${days.includes(i) ? 'border-primary bg-primary text-white' : 'border-line bg-panel text-ink hover:border-primary-line'}`}>{d}</button>
            ))}
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold">시간</span>
            <Segmented size="sm" label="시간 입력 방식" value={mode} onChange={setMode} options={[{ value: 'time', label: '시각' }, { value: 'period', label: '교시' }]} />
          </div>
          {mode === 'time' ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="시작"><input type="time" step="300" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="종료"><input type="time" step="300" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="시작 교시"><select className={inputCls} value={p1} onChange={(e) => setP1(+e.target.value)}>{PERIODS.map((p) => <option key={p.n} value={p.n}>{p.n}교시 ({toHHMM(p.start)})</option>)}</select></Field>
              <Field label="끝 교시"><select className={inputCls} value={p2} onChange={(e) => setP2(+e.target.value)}>{PERIODS.map((p) => <option key={p.n} value={p.n}>{p.n}교시 (~{toHHMM(p.end)})</option>)}</select></Field>
              <p className="col-span-2 text-xs text-ink-muted">{times.start}–{times.end} · 교시표는 1교시 09:00부터 1시간 간격(50분 수업)으로 가정했어요.</p>
            </div>
          )}
        </div>
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
          <Field label="강의 건물">
            <select className={inputCls} value={building} onChange={(e) => setBuilding(e.target.value)}>
              <option value="">건물 선택</option>
              {SORTED.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              <option value="__custom">기타(직접 입력)</option>
            </select>
          </Field>
          <Field label="강의실"><input className={inputCls} value={room} onChange={(e) => setRoom(e.target.value)} placeholder="예: 301" maxLength={12} /></Field>
          {building === '__custom' && <Field className="col-span-2" label="건물 이름"><input className={inputCls} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="예: 새 강의동" /></Field>}
          <p className="col-span-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted">
            {bName ? (walk ? <>도보시간 — 정문 하차 <b className="text-ink">{walk.정문}분</b> · 후문 하차 <b className="text-ink">{walk.후문}분</b> ({walk.src})</> : <>등록된 도보시간이 없어 기본 {DEFAULT_WALK_MIN}분을 씁니다.</>) : '건물을 고르면 정문·후문에서 걷는 시간이 보여요.'}
          </p>
        </div>
        <div className="grid gap-1.5">
          <span className="text-[13px] font-semibold">색</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="블록 색">
            {COURSE_COLORS.map((c, i) => (
              <button key={i} type="button" role="radio" aria-checked={color === i} aria-label={`색 ${i + 1}`} onClick={() => setColor(i)}
                className={`h-8 w-8 rounded-full border-2 ${color === i ? 'border-ink' : 'border-transparent'}`} style={{ background: c.bg }} />
            ))}
          </div>
        </div>
        {overlaps.length > 0 && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">겹치는 수업: {overlaps.map((c) => `${DAYS[c.day]} ${c.start} ${c.name}`).join(', ')}</p>}
        {touched && errors.length > 0 && <ul className="grid gap-0.5 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      </div>
    </Modal>
  );
}
