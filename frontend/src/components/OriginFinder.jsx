import { useEffect, useRef, useState } from 'react';
import { DAYS } from '@shared/time.js';
import { NEARBY_REASONS, nearbyNoneText, planTransit } from '@shared/transitPlan.js';
import { api } from '../lib/api.js';
import { SAMPLE_GPS, sampleTransitSearch } from '@source';
import { Button, IconAlert, IconBus, IconCheck, IconLocate, IconRoute, IconStop } from './ui.jsx';
import { StopSearch } from './StopPicker.jsx';
import RouteCard from './RouteCard.jsx';

/** 경로 목록 · 저장한 경로에 보여 줄 '다음 수업 기준' 표준 계산(실시간은 홈에서) */
export function useNextPlan({ now, todayClass, nextClass, walkTable, marginMin, personalOffsetMin }) {
  const today = todayClass && now.minutes < Number(todayClass.start.slice(0, 2)) * 60 + Number(todayClass.start.slice(3)) ? todayClass : null;
  const cls = today || nextClass;
  const note = cls ? `${today ? '오늘' : `${DAYS[cls.day]}요일`} ${cls.start} ${cls.name} 수업 기준 · 기다림은 배차간격으로 예상(실시간은 홈에서)` : '시간표를 등록하면 출발 · 도착 시각도 보여 드려요';
  const plan = (route) => (cls ? planTransit({ route, cls, nowMin: today ? now.minutes : 0, walkTable, marginMin, personalOffsetMin }) : null);
  return { plan, note };
}

// 미리보기 전용: 검색 결과 모양 고르기(실제 서비스는 서버 · ODsay가 정함)
const PREVIEW_RESULTS = [['ok', '정상'], ['stale', '한도 초과 · 예전 경로'], ['nearby', '한도 초과 · 근처 정류장'], ['none', '한도 초과 · 근처 없음']];

/**
 * v2.1 출발지 찾기(처음 화면 · 설정 공통): 현재 위치(GPS) 또는 역 · 정류장 이름 → ODsay 추천 경로 최대 3개 → [이 경로로 안내 설정]
 * 경로를 못 찾으면 차례로: 예전에 찾아 둔 경로(서버가 날짜와 함께) → 출발지 400m 안 국민대행 정류장(경로를 고른 적이 없으면 자동으로 직행 안내)
 * → 내일 다시 찾기 안내 + 큰 환승역 이름으로 찾기
 * 찾는 칸(GPS · 이름 검색 · 안내)은 wrap(controls)로 감싼 카드 안에, 경로 카드 목록은 그 카드 밖에(좁은 휴대폰에서도 막대가 한 줄로)
 * @param {{ mode, state, dispatch, now, todayClass, nextClass, walkTable, onDone?: (kind: 'route'|'fallback') => void, autoOrigin?: object|null, onCancel?: () => void, wrap?: (controls) => any }} p
 */
export default function OriginFinder({ mode, state, dispatch, now, todayClass, nextClass, walkTable, onDone, autoOrigin = null, onCancel = null, wrap = (c) => c }) {
  const tr = state.transit || {};
  const [res, setRes] = useState(null);
  const [query, setQuery] = useState(null); // 마지막으로 찾은 출발지(다시 찾기 · 근처 정류장 저장용)
  const [busy, setBusy] = useState(''); // 'gps' | 'search' | 'save' | 'fallback'
  const [err, setErr] = useState('');
  const [scenario, setScenario] = useState('ok');
  const [applied, setApplied] = useState(null); // 직행 안내로 정한 정류장 arsId
  const next = useNextPlan({ now, todayClass, nextClass, walkTable, marginMin: state.prefs.marginMin, personalOffsetMin: state.personal?.offsetMin || 0 });

  async function search(o) {
    setErr(''); setRes(null); setApplied(null); setQuery(o); setBusy('search');
    const r = mode === 'api'
      ? await api.transitSearch(o).catch((e) => ({ ok: false, fallback: 'direct', reason: 'error', message: `경로를 찾지 못했어요(${e.message})` }))
      : sampleTransitSearch(o, { scenario, nowMin: now.minutes }); // 미리보기: 심야 안내는 미리보기 시각으로
    setRes(r); setBusy('');
  }
  // 홈의 [경로 다시 찾기]: 기억해 둔 출발지로 바로 다시 찾기(한 번만)
  const autoDone = useRef(false);
  useEffect(() => {
    if (autoOrigin && !autoDone.current && Number.isFinite(autoOrigin.lat)) { autoDone.current = true; search({ name: autoOrigin.name, lat: autoOrigin.lat, lon: autoOrigin.lon, kind: autoOrigin.kind || 'stop', arsId: autoOrigin.arsId }); }
  }, [autoOrigin]); // eslint-disable-line react-hooks/exhaustive-deps

  function gps() {
    setErr('');
    if (mode !== 'api') { search({ lat: SAMPLE_GPS.lat, lon: SAMPLE_GPS.lon, kind: 'gps', name: '' }); return; }
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
    if (mode !== 'api') { dispatch({ type: 'transitSaved', transit: { mode: 'transit', origin: res.origin, route: path, savedAt: new Date().toISOString(), retry: null } }); setRes(null); onDone?.('route'); return; }
    setBusy('save');
    try { dispatch({ type: 'transitSaved', transit: (await api.transitSave(res.searchId, path.id)).transit }); setRes(null); onDone?.('route'); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  /** 근처 국민대행 정류장으로 직행 안내: 정류장 · 걷는 시간 저장 + 다시 찾을 출발지 기억 */
  async function applyStop(stop) {
    setErr('');
    const origin = query && Number.isFinite(query.lat) ? { name: query.name || (query.kind === 'gps' ? 'GPS로 고른 위치' : '출발지'), lat: query.lat, lon: query.lon, kind: query.kind || 'stop', arsId: query.arsId || '' } : null;
    const local = () => {
      dispatch({ type: 'setStop', stop: { arsId: stop.arsId, name: stop.name } });
      dispatch({ type: 'setPrefs', patch: { walkToStopMin: stop.walkChip } });
      dispatch({ type: 'transitSaved', transit: { ...tr, mode: 'direct', retry: origin ? { origin, reason: res?.reason || null, at: new Date().toISOString() } : null } });
    };
    if (mode !== 'api') { local(); setApplied(stop.arsId); onDone?.('fallback'); return; }
    setBusy('fallback');
    try {
      const r = await api.transitFallback({ fallbackStop: { arsId: stop.arsId, name: stop.name, walkMin: stop.walkChip }, origin, reason: res?.reason || null });
      dispatch({ type: 'setStop', stop: r.stop });
      dispatch({ type: 'setPrefs', patch: { walkToStopMin: r.prefs?.walkToStopMin ?? stop.walkChip } });
      dispatch({ type: 'transitSaved', transit: r.transit });
      setApplied(stop.arsId); onDone?.('fallback');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  // 경로를 고른 적이 없으면 가장 가까운 국민대행 정류장으로 자동 직행 안내(고른 경로가 있으면 묻고 바꿈)
  const stops = res && !res.ok ? res.nearby?.stops || [] : [];
  const current = tr.mode !== 'transit' && tr.retry ? state.stop?.arsId || null : null; // 이미 근처 정류장으로 안내 중이면 그 정류장
  const using = applied || (stops.some((s) => s.arsId === current) ? current : null);
  useEffect(() => {
    if (stops.length && !tr.route && !using && busy !== 'fallback') applyStop(stops[0]);
  }, [res]); // eslint-disable-line react-hooks/exhaustive-deps

  const controls = (
    <div className="grid gap-3" data-testid="transit-origin">
      <Button variant="primary" className="h-11 w-full rounded-2xl text-[15px]" disabled={Boolean(busy)} onClick={gps} data-testid="transit-gps">
        <IconLocate className="h-5 w-5" />{busy === 'gps' ? '위치 확인 중…' : '현재 위치(GPS)로 경로 찾기'}
      </Button>
      {mode !== 'api' && <p className="-mt-1 text-xs text-ink-muted">미리보기에서는 ‘{SAMPLE_GPS?.label}’를 현재 위치로 써요(실제 위치 아님).</p>}
      <p className="text-xs font-semibold text-ink-muted">또는 역 · 정류장 이름으로 찾기</p>
      <StopSearch mode={mode} source="origins" nearby={false} placeholder="역 · 정류장 이름 (예: 건대입구역)"
        onSelect={(s) => (Number.isFinite(s.lat) ? search({ name: s.name, lat: s.lat, lon: s.lon, kind: 'stop', arsId: s.arsId }) : setErr('이 정류장은 위치 정보가 없어요. 다른 이름으로 찾아 주세요.'))} />
      {mode !== 'api' && (
        <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          미리보기 · 검색 결과
          <select aria-label="미리보기 검색 결과" value={scenario} onChange={(e) => setScenario(e.target.value)} className="h-7 rounded-md border border-line bg-panel px-1 text-[12px] font-semibold text-ink">
            {PREVIEW_RESULTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      )}
      {onCancel && <div><Button size="sm" variant="ghost" onClick={onCancel}>저장한 경로 그대로 쓰기</Button></div>}
      {busy === 'search' && <p className="px-1 text-sm text-ink-muted" role="status">국민대까지 경로를 찾는 중…</p>}
      {err && <p className="rounded-xl bg-stop-soft px-3 py-2 text-sm text-stop" role="alert">{err}</p>}
    </div>
  );
  return (
    <>
      {wrap(controls)}
      {res && !res.ok && <Fallback res={res} stops={stops} applied={using} hasRoute={Boolean(tr.route)} busy={busy === 'fallback'} onApply={applyStop} />}
      {res?.ok && (
        <div className="grid gap-3" data-testid="transit-results" data-stale={res.stale ? 'true' : 'false'}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[13px] text-ink-muted">
            <IconRoute className="h-4 w-4 text-primary" />
            <span><b className="font-semibold text-ink">{res.origin.name}</b> → 국민대 정문 · ODsay 추천 경로 {res.paths.length}개</span>
            <span data-testid="transit-calls">{res.stale ? '' : res.cached ? '· 저장된 검색 결과(오늘 호출 안 씀)' : `· 새로 검색 · 오늘 ${res.calls?.today ?? '?'}/${res.calls?.cap ?? 25}회`}</span>
            {res.stale && <span data-testid="stale-tag" className="inline-flex h-[22px] items-center rounded-md border border-[#F0C98A] bg-warn-soft px-2 text-[12px] font-bold text-warn">{res.ageDays}일 전에 찾은 경로</span>}
            {res.sample && <span className="inline-flex h-5 items-center rounded border border-dashed border-ink-muted px-1.5 text-[11px] font-semibold">예시 데이터 · 실시간 아님</span>}
          </p>
          {res.stale && (
            <div role="status" data-testid="stale-notice" className="grid gap-1 rounded-2xl border border-dashed border-[#E0A64A] bg-warn-soft px-4 py-3">
              <p className="flex items-start gap-2 text-[14px] font-semibold leading-snug text-warn"><IconAlert className="mt-0.5 h-4 w-4 shrink-0" />{res.message}</p>
              <p className="text-xs text-ink-muted">버스 · 지하철 도착 시각은 실시간으로 다시 계산해요 · 노선이 바뀌었을 수 있으니 내일 다시 찾으면 최신 경로로 바뀌어요</p>
            </div>
          )}
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
    </>
  );
}

// 큰 환승역으로 찾아 보라는 안내는 도움이 될 때만(키 없음 · 인증 · 저장소 문제면 역 이름으로 찾아도 똑같이 안 됨)
const BIG_TIP = {
  cap: ' 건대입구 · 왕십리 · 청량리 같은 주요 환승역은 서버가 평일 밤에 미리 찾아 두어서, 한도와 상관없이 바로 나와요.',
  error: ' 건대입구 · 왕십리 · 청량리 같은 주요 환승역은 서버가 미리 찾아 둔 경로가 있으면 바로 나와요.',
  'no-path': ' 역에서 출발하면 경로가 나올 수 있어요.',
};

/** 경로를 못 찾을 때: 이유 + (있으면) 근처 국민대행 정류장으로 직행 안내 / (없으면) 내일 다시 · 큰 환승역 이름으로 찾기 */
function Fallback({ res, stops, applied, hasRoute, busy, onApply }) {
  const looked = NEARBY_REASONS.includes(res.reason) && res.nearby;
  return (
    <div className="grid gap-3">
      <div role="status" data-testid="transit-fallback" data-reason={res.reason} className="grid gap-1.5 rounded-2xl border border-dashed border-[#E0A64A] bg-warn-soft px-4 py-3">
        <p className="flex items-start gap-2 text-[14px] font-semibold leading-snug text-warn"><IconAlert className="mt-0.5 h-4 w-4 shrink-0" />{res.message}</p>
        {res.calls && res.reason === 'cap' && <p className="text-xs text-ink-muted">오늘 새 경로 검색 {res.calls.today}/{res.calls.cap}회 · 찾아 둔 출발지는 한도와 상관없이 바로 나와요</p>}
        {/* v2.2.6 심야(서버가 서울 시각으로 판단)면 '없어요' · '확인하지 못했어요' 대신 운행이 끝났을 수 있다는 안내(단정하지 않음) */}
        {looked && !stops.length && <p data-testid="nearby-none" data-night={res.nearby.night ? 'true' : 'false'} className="text-xs text-ink-muted">{nearbyNoneText(res.nearby)}</p>}
      </div>
      {stops.length > 0 && (
        <div data-testid="nearby-stops" className="grid gap-2 rounded-2xl border border-primary-line bg-primary-soft px-4 py-3">
          <p className="text-[14px] font-bold text-primary-active">{hasRoute && !applied ? '가까운 국민대행 정류장으로 바꿀 수도 있어요' : '그동안 가까운 국민대행 정류장으로 안내해요'}</p>
          {stops.map((s) => {
            const on = applied === s.arsId;
            return (
              <div key={s.arsId} data-testid="nearby-stop" data-on={on ? 'true' : 'false'} className={`flex items-center gap-2.5 rounded-2xl border bg-panel px-3 py-2.5 ${on ? 'border-primary ring-[3px] ring-primary-soft' : 'border-line'}`}>
                <IconStop className={`h-5 w-5 shrink-0 ${on ? 'text-primary' : 'text-ink-muted'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold">{s.name}</span>
                  <span className="flex flex-wrap items-center gap-1 text-xs text-ink-muted"><span className="num">{s.distM}</span> m · 걸어서 {s.walkMin}분 ·
                    {s.routes.map((n) => <span key={n} className="num inline-grid h-5 min-w-[36px] place-items-center rounded bg-branch px-1.5 text-[12px] font-bold text-white">{n}</span>)}
                  </span>
                </span>
                {on ? <span className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full bg-panel px-2.5 text-[12.5px] font-bold text-primary-active ring-1 ring-primary-line"><IconCheck className="h-3.5 w-3.5" />안내 중</span>
                  : <Button size="sm" disabled={busy} onClick={() => onApply(s)} data-testid="nearby-apply">이 정류장</Button>}
              </div>
            );
          })}
          <p className="text-xs leading-relaxed text-ink-muted">{res.sample ? '예시 데이터 · 실시간 아님 · ' : ''}출발지는 기억해 두고, 홈의 ‘경로 다시 찾기’로 바로 다시 찾을 수 있어요</p>
        </div>
      )}
      {looked && !stops.length && BIG_TIP[res.reason] && (
        <p data-testid="bigstation-tip" className="rounded-2xl border border-line bg-panel px-3.5 py-2.5 text-[13px] leading-relaxed text-ink">
          <b className="font-semibold">가까운 큰 환승역 이름으로 찾아 보세요.</b>{BIG_TIP[res.reason]}
        </p>
      )}
    </div>
  );
}
