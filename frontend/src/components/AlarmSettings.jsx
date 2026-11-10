import { useId, useState } from 'react';
import { toHHMM } from '@shared/time.js';
import { DELAY_ALERT_MIN, EARLY_WARNING_MIN, WORSEN_STEP_MIN } from '@shared/departure.js';
import { notifyPermission, requestNotifyPermission } from '../lib/platform.js';
import { api } from '../lib/api.js';
import { Button, Card, Chip, IconBell, RouteBadge, Segmented, SourceTag } from './ui.jsx';

const PERM = { granted: ['ok', '허용됨'], denied: ['danger', '차단됨'], default: ['muted', '아직 묻지 않음'], unsupported: ['muted', '이 환경에서 사용 불가'] };
const KU_STOPS = ['국민대학교앞', '국민대앞', '국민대후문'];
const SYNC = { synced: ['ok', '서버와 동기화됨(synced)'], error: ['danger', '서버 동기화 오류(error)'], loading: ['muted', '서버 연결 중'], off: ['muted', '서버 없음'] };
const PUSH = { synced: ['ok', '서버 푸시 켜짐(synced)'], error: ['danger', '서버 푸시 오류(error)'], working: ['muted', '등록 중…'], idle: ['muted', '꺼짐'] };

/** 노선 하나의 승차 정류장 번호(boardArsId)·하차 정류장(alightName) 입력 */
function RouteStops({ route, dispatch, serverMode, liveRoute }) {
  const uid = useId();
  const [draft, setDraft] = useState(route.boardArsId || '');
  const [list, setList] = useState({ state: 'idle', stations: [] });
  const valid = draft === '' || /^\d{5}$/.test(draft);
  const save = (patch) => dispatch({ type: 'updateRoute', id: route.id, patch });
  const onBoard = (v) => { const d = v.replace(/\D/g, '').slice(0, 5); setDraft(d); if (d === '' || d.length === 5) save({ boardArsId: d }); };
  const load = async () => {
    setList({ state: 'loading', stations: [] });
    try { const j = await api.routeStations(route.no, route.busRouteId); setList({ state: 'ok', stations: j.stations }); } catch (e) { setList({ state: 'error', stations: [], error: e.message }); }
  };
  const alightOptions = [...new Set([...KU_STOPS, ...list.stations.filter((s) => /국민대/.test(s.name)).map((s) => s.name)])];
  return (
    <div className="grid gap-2 border-t border-line/70 pt-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <label className="grid gap-1 text-xs font-semibold">승차 정류장 번호(arsId)
        <input value={draft} onChange={(e) => onBoard(e.target.value)} inputMode="numeric" placeholder="예: 08123 (정류장 표지판 5자리)" list={`${uid}-st`}
          aria-invalid={!valid} aria-label={`${route.no}번 승차 정류장 번호`}
          className={`num h-9 rounded-lg border px-2.5 text-[15px] font-normal outline-none focus:border-primary ${valid ? 'border-line' : 'border-danger'}`} />
        <datalist id={`${uid}-st`}>{list.stations.map((s) => <option key={`${s.seq}-${s.arsId}`} value={s.arsId}>{`${s.seq}. ${s.name}${s.direction ? ` (${s.direction} 방면)` : ''}`}</option>)}</datalist>
        {!valid && <span className="font-normal text-danger">숫자 5자리를 입력하세요</span>}
      </label>
      <label className="grid gap-1 text-xs font-semibold">하차 정류장 이름
        <input defaultValue={route.alightName || route.stop} list={`${uid}-al`} aria-label={`${route.no}번 하차 정류장`}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== route.alightName) save({ alightName: v }); }}
          className="h-9 rounded-lg border border-line px-2.5 text-[14px] font-normal outline-none focus:border-primary" />
        <datalist id={`${uid}-al`}>{alightOptions.map((n) => <option key={n} value={n} />)}</datalist>
      </label>
      {serverMode && <Button size="sm" onClick={load} disabled={list.state === 'loading'}>{list.state === 'loading' ? '불러오는 중…' : '노선 정류장 불러오기'}</Button>}
      <p className="text-xs text-ink-muted sm:col-span-3" data-testid={`route-status-${route.id}`}>
        {list.state === 'error' && <span className="mr-2 text-danger">정류장 목록: {list.error}</span>}
        {list.state === 'ok' && <span className="mr-2">정류장 {list.stations.length}곳을 불러왔어요 — 번호 칸에서 고르세요. </span>}
        {liveRoute?.source === 'seoul' && Number.isFinite(liveRoute.liveMin)
          ? <span className="text-primary-active">서울시 실시간: {liveRoute.inVehicle?.board} → {liveRoute.inVehicle?.alight} 차내 {liveRoute.inVehicle?.minutes}분(중간 정류장 {liveRoute.inVehicle?.intermediateStops}곳 × 20초 포함)</span>
          : liveRoute?.error ? <span className="text-warn">{liveRoute.error}</span>
            : !route.boardArsId ? '승차 정류장 번호를 넣으면 서울시 실시간 구간 속도로 계산해요.' : '예시 데이터로 계산 중이에요.'}
      </p>
    </div>
  );
}

/** 알림 시점·여유시간·브라우저 알림 권한·서버 푸시·이용 노선(승차·하차 정류장) 설정 */
export default function AlarmSettings({ settings, routes, primaryId, log, dispatch, onPreview, serverMode = false, sync, live, health }) {
  const [perm, setPerm] = useState(notifyPermission());
  const ask = async () => setPerm(await requestNotifyPermission());
  const [lvl, label] = PERM[perm] || PERM.unsupported;
  const push = sync?.push || { state: 'idle' };
  const liveById = Object.fromEntries((live?.routes || []).map((r) => [r.id, r]));
  return (
    <Card id="settings" title="알림 설정">
      <div className="grid gap-5 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">브라우저 알림</span><Chip level={lvl}>{label}</Chip>
          {perm === 'default' && <Button size="sm" variant="primary" onClick={ask}><IconBell className="h-4 w-4" />알림 허용</Button>}
          <Button size="sm" onClick={onPreview}>테스트 알림</Button>
          <p className="basis-full text-xs text-ink-muted">{perm === 'granted' ? '출발 알림이 화면 팝업과 함께 시스템 알림으로도 갑니다.' : '시스템 알림을 쓸 수 없을 때도 화면 팝업으로는 항상 알려 드려요.'}</p>
        </div>

        {serverMode && (
          <div className="grid gap-2 rounded-xl border border-line px-4 py-3" data-testid="server-panel">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">실시간 데이터</span>
              <SourceTag source={health?.provider} reason={health?.reason} />
              {health?.live?.lastOkAt && <span className="text-xs text-ink-muted">마지막 서울시 응답 {new Date(health.live.lastOkAt).toLocaleTimeString('ko-KR', { hour12: false })} · 캐시 {health.live.cacheSec}초</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">서버 동기화</span>
              <Chip level={(SYNC[sync?.status] || SYNC.loading)[0]}>{(SYNC[sync?.status] || SYNC.loading)[1]}</Chip>
              {sync?.status === 'error' && <span className="text-xs text-danger">{sync.error}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">서버 푸시</span>
              <Chip level={(PUSH[push.state] || PUSH.idle)[0]}>{(PUSH[push.state] || PUSH.idle)[1]}</Chip>
              <Button size="sm" variant={push.state === 'synced' ? 'default' : 'primary'} disabled={push.state === 'working'} onClick={sync?.enablePush}>
                {push.state === 'synced' ? '다시 등록' : push.state === 'error' ? '다시 시도' : '서버 푸시 켜기'}
              </Button>
              {push.message && <p className={`basis-full text-xs ${push.state === 'error' ? 'text-danger' : 'text-ink-muted'}`} role="status">{push.message}</p>}
              {health && !health.push?.enabled && <p className="basis-full text-xs text-ink-muted">서버에 VAPID 키가 없으면 서버 푸시를 켤 수 없어요(backend/.env).</p>}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <span className="text-[13px] font-semibold">출발 몇 분 전에 알릴까요?</span>
            <Segmented size="sm" label="알림 시점" value={settings.notifyBeforeMin} onChange={(v) => dispatch({ type: 'setSettings', patch: { notifyBeforeMin: v } })}
              options={[5, 10, 15, 20, 30].map((v) => ({ value: v, label: `${v}분` }))} />
          </div>
          <div className="grid gap-1.5">
            <span className="text-[13px] font-semibold">여유시간</span>
            <Segmented size="sm" label="여유시간" value={settings.marginMin} onChange={(v) => dispatch({ type: 'setSettings', patch: { marginMin: v } })}
              options={[0, 5, 10, 15].map((v) => ({ value: v, label: `${v}분` }))} />
          </div>
        </div>
        <div className="grid gap-2">
          <span className="text-[13px] font-semibold">이용 노선 <span className="font-normal text-ink-muted">· 실시간 소요 = 내 승차 정류장 → 학교 하차 정류장 구간 속도 합 + 중간 정류장 × 20초</span></span>
          <ul className="grid gap-2">
            {routes.map((r) => (
              <li key={r.id} className={`grid gap-2 rounded-xl border px-3 py-2 ${r.id === primaryId ? 'border-primary bg-primary-soft/40' : 'border-line'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <RouteBadge route={r} size="sm" />
                  <span className="text-sm font-semibold">{r.gate} 하차</span>
                  <span className="text-xs text-ink-muted">{r.alightName || r.stop}</span>
                  <label className="ml-auto flex items-center gap-1 text-xs text-ink-muted">평소
                    <input type="number" min={1} max={120} value={r.usualMin} aria-label={`${r.no}번 평소 소요(분)`}
                      onChange={(e) => dispatch({ type: 'updateRoute', id: r.id, patch: { usualMin: Math.max(1, Math.min(120, +e.target.value || 1)) } })}
                      className="num h-8 w-14 rounded-md border border-line px-2 text-right text-[15px] text-ink outline-none focus:border-primary" />분
                  </label>
                  <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" className="h-4 w-4 accent-[#206DEF]" checked={r.enabled !== false}
                    onChange={(e) => dispatch({ type: 'updateRoute', id: r.id, patch: { enabled: e.target.checked } })} />사용</label>
                  {r.id === primaryId ? <Chip level="info">주 노선</Chip>
                    : <button type="button" className="text-xs font-semibold text-primary hover:text-primary-active" onClick={() => dispatch({ type: 'setPrimary', id: r.id })}>주 노선으로</button>}
                </div>
                <RouteStops route={r} dispatch={dispatch} serverMode={serverMode} liveRoute={liveById[r.id]} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted">평소 소요시간은 같은 요일·시간대의 서울시 실측값이 쌓이면 자동으로 그 값을 써요(그 전에는 여기 입력한 값).</p>
        </div>
        <details className="rounded-xl bg-surface px-4 py-3 text-[13px]">
          <summary className="cursor-pointer font-semibold">알림은 언제 오나요?</summary>
          <ul className="mt-2 grid list-disc gap-1 pl-5 text-ink-muted">
            <li>권장 출발 {settings.notifyBeforeMin}분 전에 출발 알림이 옵니다.</li>
            <li>주 노선이 평소보다 {DELAY_ALERT_MIN}분 이상 늦으면 출발 알림 {EARLY_WARNING_MIN}분 전부터 지연 알림을 먼저 보내고, 대체 노선이 있으면 함께 알려 드려요.</li>
            <li>알림 뒤 지연이 {WORSEN_STEP_MIN}분 더 늘면 다시 알려 드려요. 첫 수업이 시작되면 그날 알림은 멈춥니다.</li>
            <li>서울시 API에 연결할 수 없을 때는 예시 데이터로 계산하고, 화면과 푸시에 '예시 데이터'라고 표시해요.</li>
          </ul>
        </details>
        {log.length > 0 && (
          <div className="grid gap-1.5">
            <span className="text-[13px] font-semibold">최근 알림</span>
            <ul className="grid gap-1 text-[13px]">
              {log.slice(0, 5).map((a, i) => (
                <li key={i} className="flex gap-2"><span className="num w-11 shrink-0 text-ink-muted">{toHHMM(a.atMin)}</span><span className="min-w-0">{a.title}{(a.mock || String(a.key || '').endsWith(':mock')) && <span className="ml-1 text-xs text-ink-muted" data-testid="log-mock">(예시 데이터 기준)</span>}</span></li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
