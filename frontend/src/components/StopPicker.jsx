import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { sampleSearch } from '@source';
import { IconLocate, IconSearch, IconStop, Modal } from './ui.jsx';

/** 탑승 정류장 검색(이름) · 내 주변 정류장(위치). 결과를 누르면 그 정류장 하나만 저장합니다. */
export function StopSearch({ mode, onSelect }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ state: 'idle', stops: [] });
  useEffect(() => {
    if (mode === 'sample') { setRes({ state: 'ok', stops: sampleSearch(q) }); return undefined; }
    if (q.trim().length < 2) { setRes({ state: 'idle', stops: [] }); return undefined; }
    setRes((r) => ({ ...r, state: 'loading' }));
    const t = setTimeout(() => api.searchStops(q.trim()).then((j) => setRes({ state: 'ok', stops: j.stops })).catch((e) => setRes({ state: 'error', stops: [], error: e.message })), 300);
    return () => clearTimeout(t);
  }, [q, mode]);
  const near = () => {
    if (!navigator.geolocation) { setRes({ state: 'error', stops: [], error: '위치 기능을 쓸 수 없어요. 이름으로 검색해 주세요.' }); return; }
    setRes({ state: 'loading', stops: [] });
    navigator.geolocation.getCurrentPosition(
      (pos) => api.nearStops(pos.coords.latitude, pos.coords.longitude).then((j) => setRes({ state: 'ok', stops: j.stops, near: true })).catch((e) => setRes({ state: 'error', stops: [], error: e.message })),
      () => setRes({ state: 'error', stops: [], error: '위치 권한이 없어요. 정류장 이름으로 검색해 주세요.' }), { timeout: 8000 });
  };
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">정류장 이름</span>
          <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="정류장 이름 (예: 고려대부고)" autoComplete="off"
            className="h-12 w-full rounded-2xl border border-line bg-surface pl-11 pr-4 text-[15px] outline-none transition focus:border-primary focus:bg-panel focus:ring-[3px] focus:ring-primary-soft" />
        </label>
        {mode === 'api' && (
          <button type="button" onClick={near} className="flex h-12 shrink-0 items-center gap-1.5 rounded-2xl border border-line bg-panel px-3.5 text-[14px] font-semibold hover:border-primary-line hover:text-primary">
            <IconLocate className="h-5 w-5" /><span className="hidden sm:inline">내 주변</span>
          </button>
        )}
      </div>
      {res.state === 'loading' && <p className="text-sm text-ink-muted">찾는 중…</p>}
      {res.state === 'error' && <p className="rounded-xl bg-stop-soft px-3 py-2 text-sm text-stop">{res.error}</p>}
      {res.state === 'ok' && !res.stops.length && <p className="text-sm text-ink-muted">맞는 정류장이 없어요. 다른 이름으로 찾아보세요.</p>}
      {res.stops.length > 0 && (
        <ul className="grid max-h-[46vh] grid-cols-1 gap-1.5 overflow-y-auto">
          {res.stops.map((s) => (
            <li key={s.arsId}>
              <button type="button" onClick={() => onSelect({ arsId: s.arsId, name: s.name })}
                className="flex w-full items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3 text-left hover:border-primary hover:bg-primary-soft">
                <IconStop className="h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-bold">{s.name}</span>
                  <span className="block text-xs text-ink-muted">정류장 번호 <span className="num">{s.arsId}</span>{Number.isFinite(s.distM) ? ` · ${Math.round(s.distM)} m` : ''}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {mode === 'sample' && <p className="text-xs text-ink-muted">미리보기에는 샘플 정류장 3곳만 있어요. 실제 서비스에서는 서울시 정류장 전체를 검색합니다.</p>}
    </div>
  );
}

export default function StopPicker({ mode, onSelect, onClose }) {
  return <Modal title="탑승 정류장 고르기" onClose={onClose}><StopSearch mode={mode} onSelect={onSelect} /></Modal>;
}
