import { useState } from 'react';
import { BUILDINGS, DEFAULT_WALK_MIN, GATES, WALK_TABLE } from '@shared/campusData.js';
import { Card, Chip, Segmented } from './ui.jsx';

/** 하차 정류장(정문/후문) → 건물 도보시간 표. 값을 고치면 이 기기에 저장되고 계산에 바로 반영됩니다. */
export default function WalkTable({ walkTable, overrides, myBuildings, onChange }) {
  const [scope, setScope] = useState('mine');
  const names = [...BUILDINGS.map((b) => b.name)].sort((a, b) => a.localeCompare(b, 'ko'));
  const list = scope === 'mine' ? names.filter((n) => myBuildings.has(n)) : names;
  const unknown = [...myBuildings].filter((n) => n && !WALK_TABLE[n]);
  const cell = (b, gate) => {
    const edited = overrides[b]?.[gate] != null;
    return (
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-1">
          <input type="number" min={1} max={30} inputMode="numeric" value={walkTable[b][gate]} aria-label={`${b} ${gate} 하차 도보시간(분)`}
            onChange={(e) => onChange(b, gate, e.target.value === '' ? null : Math.max(1, Math.min(30, Math.round(+e.target.value))))}
            className={`num h-8 w-14 rounded-md border px-2 text-right text-[15px] outline-none focus:border-primary ${edited ? 'border-primary bg-primary-soft' : 'border-line bg-panel'}`} />
          <span className="text-xs text-ink-muted">분</span>
        </div>
      </td>
    );
  };
  return (
    <Card title="건물별 도보시간" aside={<Segmented size="sm" label="표시 범위" value={scope} onChange={setScope} options={[{ value: 'mine', label: '내 시간표' }, { value: 'all', label: `전체 ${names.length}동` }]} />}>
      <p className="px-5 pt-3 text-xs text-ink-muted">정문 = {GATES.정문.stop} 정류장, 후문 = {GATES.후문.stop} 정류장에서 내려 건물까지 걷는 시간입니다. 표에 없는 건물은 기본 {DEFAULT_WALK_MIN}분을 씁니다.</p>
      <div className="overflow-x-auto px-3 pb-3 pt-2">
        <table className="w-full min-w-[300px] text-sm">
          <thead><tr className="text-left text-xs text-ink-muted"><th className="px-2 py-1.5 font-semibold">건물</th><th className="px-2 py-1.5 text-right font-semibold">정문</th><th className="px-2 py-1.5 text-right font-semibold">후문</th><th className="px-2 py-1.5 font-semibold">근거</th></tr></thead>
          <tbody className="divide-y divide-line">
            {list.map((b) => (
              <tr key={b}>
                <td className="px-2 py-1.5 font-semibold">{b}</td>
                {cell(b, '정문')}{cell(b, '후문')}
                <td className="px-2 py-1.5">{overrides[b] && Object.keys(overrides[b]).length ? <Chip level="info">수정</Chip> : <Chip level={WALK_TABLE[b].src === '지정' ? 'info' : 'muted'}>{WALK_TABLE[b].src}</Chip>}</td>
              </tr>
            ))}
            {unknown.map((b) => (
              <tr key={b}><td className="px-2 py-1.5 font-semibold">{b}</td><td className="num px-2 py-1.5 text-right" colSpan={2}>{DEFAULT_WALK_MIN}분 (기본값)</td><td className="px-2 py-1.5"><Chip>기본</Chip></td></tr>
            ))}
          </tbody>
        </table>
        {!list.length && !unknown.length && <p className="px-2 py-3 text-sm text-ink-muted">시간표에 건물이 없어요.</p>}
      </div>
      <p className="border-t border-line px-5 py-2.5 text-xs text-ink-muted">추정 = OSM 지도에서 계산한 직선거리 기반 값(경사 미반영) · 지정 = 요구사항에 주어진 값. 실제로 걸어 보고 고쳐 주세요.</p>
    </Card>
  );
}
