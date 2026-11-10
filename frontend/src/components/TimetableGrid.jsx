import { useRef, useState } from 'react';
import { DAYS, toHHMM, toMin } from '@shared/time.js';
import { courseColor } from '../lib/palette.js';

export const GRID_START_H = 9, GRID_END_H = 18;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DAY_LABELS = [...DAYS, '토'];

/**
 * 표에 보일 시간 범위와 요일 수: 기본 월~금 09~18시, 수업(과 미리보기)이 더 이르거나 늦으면 넓히고(07~24시), 토요일 수업이 있으면 토요일 칸을 더함
 * @returns {{ startH:number, endH:number, days:number }}
 */
export function gridRange(items) {
  let startH = GRID_START_H, endH = GRID_END_H, days = 5;
  for (const c of items || []) {
    const s = toMin(c.start), e = toMin(c.end);
    if (Number.isFinite(s)) startH = Math.min(startH, Math.max(7, Math.floor(s / 60)));
    if (Number.isFinite(e)) endH = Math.max(endH, Math.min(24, Math.ceil(e / 60)));
    if (c.day === 5) days = 6;
  }
  return { startH, endH, days };
}

/**
 * 에브리타임식 주간 시간표(월~금(토) × 09~18시, 수업에 맞춰 넓어짐).
 * - 빈 칸을 누르면 그 30분 칸에서 75분 수업, 마우스로 끌면 끈 범위(15분 단위)로 '수업 추가'를 엽니다.
 * - 수업 블록을 누르면 '수업 수정'을 엽니다.
 * - preview: 수업 검색에서 고른 강의를 점선으로 미리 보여 줌(겹치면 빨강)
 */
export default function TimetableGrid({ classes, preview = [], today, nowMin, highlightId, onCreate, onEdit, hourPx = 56 }) {
  const { startH, endH, days } = gridRange([...classes, ...preview]);
  const startMin = startH * 60, endMin = endH * 60, total = endMin - startMin;
  const labels = DAY_LABELS.slice(0, days);
  const height = (total / 60) * hourPx;
  const [sel, setSel] = useState(null);
  const colRefs = useRef([]);
  const yToMin = (day, clientY) => {
    const r = colRefs.current[day].getBoundingClientRect();
    return clamp(startMin + ((clientY - r.top) / r.height) * total, startMin, endMin);
  };
  const down = (e, day) => {
    if (e.button !== 0 || e.target.closest('[data-block]')) return;
    const m = yToMin(day, e.clientY);
    if (e.pointerType === 'mouse') e.currentTarget.setPointerCapture(e.pointerId);
    setSel({ day, a: m, b: m, y0: e.clientY, moved: false });
  };
  const move = (e) => sel && setSel((s) => ({ ...s, b: yToMin(s.day, e.clientY), moved: s.moved || Math.abs(e.clientY - s.y0) > 6 }));
  const up = () => {
    if (!sel) return;
    let a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
    if (!sel.moved || b - a < 20) { a = Math.floor(a / 30) * 30; b = a + 75; } else { a = Math.round(a / 15) * 15; b = Math.round(b / 15) * 15; }
    onCreate({ day: sel.day, start: toHHMM(a), end: toHHMM(Math.min(b, 22 * 60)) });
    setSel(null);
  };
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i);
  const cols = { gridTemplateColumns: `34px repeat(${days}, minmax(0, 1fr))` };
  return (
    <div className="select-none">
      <div className="grid" style={cols}>
        <div />
        {labels.map((d, i) => (
          <div key={d} className={`pb-2 text-center text-[13px] font-bold ${i === today ? 'text-primary' : 'text-ink-muted'}`}>
            {d}{i === today && <span className="ml-1 rounded bg-primary px-1 py-px text-[10px] text-white">오늘</span>}
          </div>
        ))}
      </div>
      <div className="grid overflow-hidden rounded-xl border border-line" style={cols}>
        <div className="relative bg-panel" style={{ height }}>
          {hours.slice(0, -1).map((h) => (
            <span key={h} className="num absolute right-1.5 top-1 text-[12px] font-semibold text-ink-muted" style={{ top: (h - startH) * hourPx + 3 }}>{h}</span>
          ))}
        </div>
        {labels.map((d, day) => (
          <div key={d} ref={(el) => { colRefs.current[day] = el; }}
            className={`relative cursor-cell border-l border-line ${day === today ? 'bg-primary-soft/50' : 'bg-panel'}`}
            style={{ height, touchAction: 'pan-y', backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${hourPx - 1}px, var(--border) ${hourPx - 1}px ${hourPx}px)` }}
            onPointerDown={(e) => down(e, day)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setSel(null)}
            aria-label={`${d}요일 칸 — 눌러서 수업 추가`}>
            {classes.filter((c) => c.day === day).map((c) => {
              const s = toMin(c.start), e = toMin(c.end);
              const top = clamp(((s - startMin) / 60) * hourPx, 0, height), bot = clamp(((e - startMin) / 60) * hourPx, 0, height);
              if (bot - top < 4) return null;
              const col = courseColor(c.color, c.name);
              return (
                <button key={c.id} type="button" data-block onClick={() => onEdit(c)}
                  className={`absolute inset-x-[2px] overflow-hidden rounded-lg px-1 py-1 text-left sm:inset-x-[3px] sm:px-1.5 transition-[filter] hover:brightness-[.96] focus-visible:z-10 ${c.id === highlightId ? 'ring-2 ring-primary ring-offset-1' : ''}`}
                  style={{ top: top + 1, height: Math.max(20, bot - top - 2), background: col.bg, color: col.ink }}
                  aria-label={`${c.name}, ${d}요일 ${c.start}부터 ${c.end}까지, ${c.building} ${c.room}. 눌러서 수정`}>
                  <span className="block break-all text-[11px] font-bold leading-[1.25] line-clamp-3 sm:break-normal sm:text-[12px] sm:line-clamp-2">{c.name}</span>
                  <span className="block truncate text-[11px] leading-tight opacity-80">{c.building} {c.room}</span>
                  {c.id === highlightId && <span className="absolute bottom-1 right-1 rounded bg-panel/90 px-1 text-[10px] font-bold text-primary">첫 수업</span>}
                </button>
              );
            })}
            {preview.filter((c) => c.day === day).map((c, i) => {
              const top = clamp(((toMin(c.start) - startMin) / 60) * hourPx, 0, height), bot = clamp(((toMin(c.end) - startMin) / 60) * hourPx, 0, height);
              return (
                <div key={`p${i}`} data-testid="preview-block" data-conflict={c.conflict ? 'true' : 'false'}
                  className={`pointer-events-none absolute inset-x-[2px] z-10 overflow-hidden rounded-lg border-2 border-dashed px-1 py-1 sm:inset-x-[3px] sm:px-1.5 ${c.conflict ? 'border-danger bg-danger-soft/90 text-danger' : 'border-primary bg-primary-soft/90 text-primary-active'}`}
                  style={{ top: top + 1, height: Math.max(20, bot - top - 2) }}>
                  <span className="block break-all text-[11px] font-bold leading-[1.25] line-clamp-2 sm:text-[12px]">{c.name}</span>
                  <span className="block truncate text-[11px] leading-tight">{c.conflict ? '겹침' : `${c.start}~${c.end}`}</span>
                </div>
              );
            })}
            {sel && sel.day === day && sel.moved && (
              <div className="pointer-events-none absolute inset-x-[3px] rounded-lg border-2 border-dashed border-primary bg-primary-soft/80"
                style={{ top: ((Math.min(sel.a, sel.b) - startMin) / 60) * hourPx, height: (Math.abs(sel.b - sel.a) / 60) * hourPx }} />
            )}
            {day === today && nowMin > startMin && nowMin < endMin && (
              <div className="pointer-events-none absolute inset-x-0 z-[5] border-t-2 border-danger" style={{ top: ((nowMin - startMin) / 60) * hourPx }}>
                <span className="absolute -left-[4px] -top-[5px] h-2 w-2 rounded-full bg-danger" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
