import { useEffect, useId, useState } from 'react';
import { DAYS } from '@shared/time.js';
import { planTransit } from '@shared/transitPlan.js';
import { api } from '../lib/api.js';
import { SAMPLE_GPS, sampleTransitSearch } from '@source';
import { Button, IconAlert, IconBus, IconLocate, IconRoute, Segmented } from './ui.jsx';
import { StopSearch } from './StopPicker.jsx';
import RouteCard from './RouteCard.jsx';

const MODES = [{ value: 'direct', label: '단일 정류장 직행' }, { value: 'transit', label: '출발지 환승 경로' }];

/** 경로 목록 · 저장한 경로에 보여 줄 '다음 수업 기준' 표준 계산(실시간은 홈에서) */
function useNextPlan({ now, todayClass, nextClass, walkTable, marginMin, personalOffsetMin }) {
  const today = todayClass && now.minutes < Number(todayClass.start.slice(0, 2)) * 60 + Number(todayClass.start.slice(3)) ? todayClass : null;
  const cls = today || nextClass;
  const note = cls ? `${today ? '오늘' : `${DAYS[cls.day]}요일`} ${cls.start} ${cls.name} 수업 기준 · 기다림은 배차간격으로 예상(실시간은 홈에서)` : '시간표를 등록하면 출발 · 도착 시각도 보여 드려요';
  const plan = (route) => (cls ? planTransit({ route, cls, nowMin: today ? now.minutes : 0, walkTable, marginMin, personalOffsetMin }) : null);
  return { plan, note };
}

/** 직행으로 안내하는 이유(한도 초과 · 키 없음 · 경로 없음 · 700m 안 …) */
function Fallback({ res, onDirect, canDirect }) {
  return (
    <div role="status" data-testid="transit-fallback" data-reason={res.reason} className="grid gap-2 rounded-2xl border border-dashed border-[#E0A64A] bg-warn-soft px-4 py-3">
      <p className="flex items-start gap-2 text-[14px] font-semibold leading-snug text-warn"><IconAlert className="mt-0.5 h-4 w-4 shrink-0" />{res.message}</p>
      {res.calls && <p className="text-xs text-ink-muted">오늘 새 경로 검색 {res.calls.today}/{res.calls.cap}회 · 저장된 출발지는 한도와 상관없이 다시 볼 수 있어요</p>}
      {canDirect && <div><Button size="sm" onClick={onDirect}>단일 정류장 직행으로 쓰기</Button></div>}
    </div>
  );
}

/**
 * 설정 · 출발 방식: [단일 정류장 직행 | 출발지 환승 경로]
 * 환승: 현재 위치(GPS) 또는 역 · 정류장 이름 → ODsay 추천 경로 최대 3개(카드) → [이 경로로 안내 설정] → 서버(외부 DB)에 저장
 */
export default function TransitSettings({ mode, state, dispatch, now, todayClass, nextClass, walkTable, highlight }) {
  const id = useId();
  const tr = state.transit, on = tr.mode === 'transit';
  const [open, setOpen] = useState(!tr.route);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(''); // 'gps' | 'search' | 'save' | 'mode'
  const [err, setErr] = useState('');
  const [capDemo, setCapDemo] = useState(false);
  // 서버에서 고른 경로를 늦게 받아 왔거나(동기화) 홈의 [바꾸기]로 왔을 때 화면 맞추기
  useEffect(() => { if (tr.route && !res) setOpen(false); }, [tr.savedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (highlight && tr.route) setOpen(true); }, [highlight]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = useNextPlan({ now, todayClass, nextClass, walkTable, marginMin: state.prefs.marginMin, personalOffsetMin: state.personal?.offsetMin || 0 });

  const save = (transit) => dispatch({ type: 'transitSaved', transit });
  async function setMode(m) {
    setErr('');
    if (mode !== 'api') { save({ ...tr, mode: m }); return; }
    setBusy('mode');
    try { save((await api.transitMode(m)).transit); } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function search(o) {
    setErr(''); setRes(null); setBusy('search');
    const r = mode === 'api'
      ? await api.transitSearch(o).catch((e) => ({ ok: false, fallback: 'direct', reason: 'error', message: `경로를 찾지 못했어요(${e.message}) — 단일 정류장 직행으로 안내해요` }))
      : sampleTransitSearch(o, { capDemo });
    setRes(r); setBusy('');
  }
  function gps() {
    setErr('');
    if (mode !== 'api') { search({ lat: SAMPLE_GPS.lat, lon: SAMPLE_GPS.lon, kind: 'gps' }); return; }
    if (!navigator.geolocation) { setErr('위치 기능을 쓸 수 없어요. 역 · 정류장 이름으로 찾아 주세요.'); return; }
    setBusy('gps');
    navigator.geolocation.getCurrentPosition(
      (pos) => search({ lat: pos.coords.latitude, lon: pos.coords.longitude, kind: 'gps' }),
      () => { setBusy(''); setErr('위치 권한이 없어요. 역 · 정류장 이름으로 찾아 주세요(아이폰: 설정 → 개인정보 보호 → 위치 서비스).'); },
      { timeout: 12000, enableHighAccuracy: true, maximumAge: 60000 },
    );
  }
  async function choose(path) {
    setErr('');
    if (mode !== 'api') { save({ mode: 'transit', origin: res.origin, route: path, savedAt: new Date().toISOString() }); setRes(null); setOpen(false); return; }
    setBusy('save');
    try { save((await api.transitSave(res.searchId, path.id)).transit); setRes(null); setOpen(false); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  return (
    <section id="transit" aria-labelledby={id} className="grid scroll-mt-24 grid-cols-1 gap-2">
      <h2 id={id} className="px-1 text-[13px] font-bold text-ink-muted">출발 방식</h2>
      <div data-testid="transit-settings" data-mode={tr.mode} className={`divide-y divide-line rounded-2xl border bg-panel shadow-card ${highlight ? 'border-primary ring-[3px] ring-primary-soft' : 'border-line'}`}>
        <div className="grid gap-2 px-4 py-3.5">
          <Segmented value={tr.mode} onChange={setMode} options={MODES} label="출발 방식" />
          <p className="text-xs leading-relaxed text-ink-muted">
            {on ? '집 · 역 같은 출발지에서 지하철 · 버스 환승 경로(ODsay)로 안내해요. 첫 지하철 · 마지막 국민대행 버스는 실시간, 환승마다 3분 여유를 더해요.'
              : '탑승 정류장 하나에서 국민대로 바로 가는 버스로 안내해요(지금까지와 같음).'}
          </p>
          {on && !tr.route && <p className="text-xs font-semibold text-warn">아직 경로를 고르지 않아 홈은 단일 정류장 직행으로 안내해요. 아래에서 출발지를 정해 주세요.</p>}
        </div>
        {on && tr.route && !open && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5" data-testid="transit-saved">
            <p className="min-w-0 text-[14px]"><span className="font-semibold">{tr.origin?.name || '출발지'}</span><span className="text-ink-muted"> → 국민대 · </span><span className="font-semibold">{tr.route.title}</span></p>
            <Button size="sm" onClick={() => { setOpen(true); setRes(null); }}>다른 경로 고르기</Button>
          </div>
        )}
        {on && open && (
          <div className="grid gap-3 px-4 py-3.5" data-testid="transit-origin">
            <p className="text-[15px] font-semibold">출발지</p>
            <Button variant="primary" className="h-11 w-full rounded-2xl text-[15px]" disabled={Boolean(busy)} onClick={gps} data-testid="transit-gps">
              <IconLocate className="h-5 w-5" />{busy === 'gps' ? '위치 확인 중…' : '현재 위치(GPS)로 경로 찾기'}
            </Button>
            {mode !== 'api' && <p className="-mt-1 text-xs text-ink-muted">미리보기에서는 ‘{SAMPLE_GPS?.label}’를 현재 위치로 써요(실제 위치 아님).</p>}
            <p className="text-xs font-semibold text-ink-muted">또는 역 · 정류장 이름으로 찾기</p>
            <StopSearch mode={mode} source="origins" nearby={false} placeholder="역 · 정류장 이름 (예: 홍대입구역)"
              onSelect={(s) => (Number.isFinite(s.lat) ? search({ name: s.name, lat: s.lat, lon: s.lon, kind: 'stop', arsId: s.arsId }) : setErr('이 정류장은 위치 정보가 없어요. 다른 이름으로 찾아 주세요.'))} />
            {mode !== 'api' && (
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="checkbox" checked={capDemo} onChange={(e) => setCapDemo(e.target.checked)} />미리보기: ‘오늘 검색 한도(25회) 초과’ 화면 보기
              </label>
            )}
            {tr.route && <div><Button size="sm" variant="ghost" onClick={() => { setOpen(false); setRes(null); }}>저장한 경로 그대로 쓰기</Button></div>}
          </div>
        )}
      </div>
      {busy === 'search' && <p className="px-1 text-sm text-ink-muted" role="status">국민대까지 경로를 찾는 중…</p>}
      {err && <p className="rounded-xl bg-stop-soft px-3 py-2 text-sm text-stop" role="alert">{err}</p>}
      {on && res && !res.ok && <Fallback res={res} canDirect={!tr.route} onDirect={() => setMode('direct')} />}
      {on && res?.ok && (
        <div className="grid gap-3" data-testid="transit-results">
          <p className="flex flex-wrap items-center gap-x-2 px-1 text-[13px] text-ink-muted">
            <IconRoute className="h-4 w-4 text-primary" />
            <span><b className="font-semibold text-ink">{res.origin.name}</b> → 국민대 정문 · ODsay 추천 경로 {res.paths.length}개</span>
            <span data-testid="transit-calls">{res.cached ? '· 저장된 검색 결과(오늘 호출 안 씀)' : `· 새로 검색 · 오늘 ${res.calls?.today ?? '?'}/${res.calls?.cap ?? 25}회`}</span>
            {res.sample && <span className="inline-flex h-5 items-center rounded border border-dashed border-ink-muted px-1.5 text-[11px] font-semibold">예시 데이터 · 실시간 아님</span>}
          </p>
          {res.paths.map((p, k) => (
            <RouteCard key={p.id} route={p} plan={next.plan(p)} badge={k === 0 ? '최적' : null} classNote={next.note} testId="route-option" sample={res.sample}
              action={(
                <Button className="h-11 w-full rounded-2xl text-[15px]" disabled={busy === 'save'} onClick={() => choose(p)} data-testid="route-choose">
                  <IconBus className="h-5 w-5 text-primary" />{busy === 'save' ? '저장하는 중…' : '이 경로로 안내 설정'}
                </Button>
              )} />
          ))}
        </div>
      )}
      {on && tr.route && !open && (
        <RouteCard route={tr.route} plan={next.plan(tr.route)} badge="내 경로" classNote={next.note} testId="transit-saved-card" />
      )}
      <p className="px-1 text-xs leading-relaxed text-ink-muted">
        새 경로 검색은 하루 25번까지(ODsay 무료 한도 보호) · 같은 출발지(같은 이름이거나 300m 안)는 30일 동안 저장한 결과를 써요. 한도를 넘거나 경로를 찾지 못하면 단일 정류장 직행으로 안내해요.
      </p>
    </section>
  );
}
