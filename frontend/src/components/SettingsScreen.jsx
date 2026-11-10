import { useId, useState } from 'react';
import { Button, Chip, IconChevron, IconCube, IconExternal, IconStop, SourceTag } from './ui.jsx';

function Group({ title, children, note }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid grid-cols-1 gap-2">
      <h2 id={id} className="px-1 text-[13px] font-bold text-ink-muted">{title}</h2>
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel shadow-card">{children}</div>
      {note && <p className="px-1 text-xs leading-relaxed text-ink-muted">{note}</p>}
    </section>
  );
}
const Item = ({ label, desc, children }) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5">
    <div className="min-w-0">
      <p className="text-[15px] font-semibold">{label}</p>
      {desc && <p className="text-xs text-ink-muted">{desc}</p>}
    </div>
    {children}
  </div>
);

/** 분 단위 선택 칩 */
function MinuteChips({ label, value, options, onChange }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1.5">
      {options.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={value === m} onClick={() => onChange(m)}
          className={`num h-9 min-w-[48px] rounded-[10px] border px-2 text-[15px] font-semibold transition-colors ${value === m ? 'border-primary bg-primary text-white' : 'border-line bg-panel hover:border-primary-line'}`}>{m}분</button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-8 w-[52px] shrink-0 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-line'}`}>
      <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-[left] ${checked ? 'left-[24px]' : 'left-1'}`} />
    </button>
  );
}

const PERM = { granted: '허용됨', denied: '차단됨 — 브라우저 설정에서 허용해 주세요', default: '아직 묻지 않음', unsupported: '이 브라우저는 지원하지 않아요' };

const SYNC = { synced: ['ok', '서버와 동기화됨(synced)'], error: ['danger', '서버 동기화 오류(error)'], loading: ['muted', '연결 중…'] };

/** 실시간 데이터 출처 · 서버 동기화 · 서버 푸시 상태 */
function ServerGroup({ mode, live, health, sync, push, onEnablePush }) {
  const src = live?.source ? { source: live.source, reason: live.reason, stale: Boolean(live.stale) || live.status === 'stale' }
    : health?.provider ? { source: health.provider, reason: health.reason } : null;
  const srcDesc = !src ? '탑승 정류장을 고르면 표시돼요'
    : src.source === 'mock' ? '실시간을 받지 못해 예시 데이터로 계산 중이에요. 연결되면 자동으로 바뀌어요.'
      : src.stale ? '서울시 연결이 잠시 끊겨 직전 값을 쓰는 중이에요.' : '서울시 버스 API에서 20초마다 받아요.';
  const [syncLevel, syncText] = mode === 'api' ? (SYNC[sync] || SYNC.loading) : ['muted', '미리보기 · 서버 없음'];
  const noVapid = mode === 'api' && health?.push && !health.push.enabled;
  const pushDesc = noVapid ? '서버에 푸시 키(VAPID)가 설정되지 않아 지금은 켤 수 없어요.'
    : push.state === 'on' ? `서버에 구독 저장됨${push.count ? `(${push.count}개)` : ''} — 창을 닫아도 알림이 와요.`
      : push.state === 'error' ? push.message : '창을 닫아도 출발 알림을 받아요.';
  const label = { off: '서버 푸시 켜기', working: '켜는 중…', on: '다시 등록', error: '다시 시도' }[push.state] || '서버 푸시 켜기';
  return (
    <Group title="데이터 · 서버 연결">
      <Item label="실시간 데이터" desc={srcDesc}>
        {src ? <SourceTag {...src} /> : <Chip>정류장 미선택</Chip>}
      </Item>
      <Item label="서버 동기화" desc="시간표·정류장·설정을 서버에 저장해요. 서버가 이 값으로 알림을 계산해요.">
        <Chip level={syncLevel}>{syncText}</Chip>
      </Item>
      <Item label="서버 푸시" desc={pushDesc}>
        <div className="flex flex-wrap items-center gap-2" data-testid="push-panel">
          {push.state === 'on' && <Chip level="ok">서버 푸시 켜짐(synced)</Chip>}
          {push.state === 'error' && <Chip level="danger">서버 푸시 오류(error)</Chip>}
          <Button size="sm" variant={push.state === 'off' ? 'primary' : 'default'} disabled={noVapid || push.state === 'working'} onClick={onEnablePush}>{label}</Button>
        </div>
      </Item>
    </Group>
  );
}

export default function SettingsScreen({ mode, state, dispatch, onPickStop, perm, onRequestPerm, onTestAlarm, push, onEnablePush, sync, live, health }) {
  const { prefs } = state;
  const setPrefs = (patch) => dispatch({ type: 'setPrefs', patch });
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <div className="mx-auto grid w-full max-w-[560px] grid-cols-1 gap-6">
      <h1 className="px-1 text-[22px] font-bold">설정</h1>

      <Group title="탑승 정류장">
        <button type="button" onClick={onPickStop} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface">
          <IconStop className="h-5 w-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{state.stop?.name || '정류장을 골라 주세요'}</span>
          <span className="flex shrink-0 items-center text-[13px] font-semibold text-primary">{state.stop ? '바꾸기' : '고르기'}<IconChevron className="h-4 w-4" /></span>
        </button>
      </Group>

      <Group title="출발 시각 계산" note="정류장까지 걷는 시간만큼 버스 탑승 시각보다 일찍 출발하도록 알려 드려요.">
        <Item label="정류장까지 걸어서"><MinuteChips label="정류장까지 걷는 시간" value={prefs.walkToStopMin} options={[3, 5, 10, 15]} onChange={(m) => setPrefs({ walkToStopMin: m })} /></Item>
        <Item label="수업 전 도착 여유"><MinuteChips label="수업 시작 전 여유" value={prefs.marginMin} options={[0, 5, 10]} onChange={(m) => setPrefs({ marginMin: m })} /></Item>
      </Group>

      <Group title="알림">
        <Item label="출발 알림" desc="출발 시각 전, 출발이 앞당겨질 때, 지각 위험일 때"><Switch label="출발 알림" checked={prefs.notify} onChange={(v) => setPrefs({ notify: v })} /></Item>
        {prefs.notify && <Item label="출발 몇 분 전에"><MinuteChips label="출발 몇 분 전에 알릴지" value={prefs.notifyBeforeMin} options={[5, 10, 15]} onChange={(m) => setPrefs({ notifyBeforeMin: m })} /></Item>}
        <Item label="브라우저 알림" desc={PERM[perm] || perm}>
          <div className="flex gap-2">
            {perm === 'default' && <Button size="sm" variant="primary" onClick={onRequestPerm}>허용하기</Button>}
            <Button size="sm" onClick={onTestAlarm}>테스트</Button>
          </div>
        </Item>
      </Group>

      <ServerGroup mode={mode} live={live} health={health} sync={sync} push={push} onEnablePush={onEnablePush} />

      <Group title="정보">
        {mode === 'sample' && (
          <a href="KU_Bus_3D_V4.html" target="_blank" rel="noopener" className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface">
            <IconCube className="h-5 w-5 shrink-0 text-primary" /><span className="flex-1 text-[15px] font-semibold">3D 캠퍼스 보기</span><IconExternal className="h-4 w-4 text-ink-muted" />
          </a>
        )}
        <div className="grid gap-1 px-4 py-3.5 text-xs leading-relaxed text-ink-muted">
          <p><span className="font-semibold text-ink">버스 도착·도로 정체</span> 서울특별시 정류소정보·노선정보 API(서버 경유, 20초마다 갱신). 받지 못하면 직전 값(3분 이내), 그다음 예시 데이터로 바꾸고 &lsquo;예시 데이터&rsquo;로 표시해요.{mode === 'sample' ? ' 이 미리보기는 같은 형식의 샘플 응답이에요.' : ''}</p>
          <p><span className="font-semibold text-ink">캠퍼스 도보 시간</span> OpenStreetMap 기반 추정 · 지도 데이터 © OpenStreetMap contributors (ODbL)</p>
        </div>
      </Group>

      <div className="flex flex-wrap items-center gap-2 px-1 pb-4">
        {confirmReset
          ? <><Button variant="danger" size="sm" onClick={() => { dispatch({ type: 'resetAll' }); setConfirmReset(false); }}>시간표·설정 모두 지우기</Button><Button size="sm" onClick={() => setConfirmReset(false)}>취소</Button></>
          : <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>처음 상태로 되돌리기</Button>}
      </div>
    </div>
  );
}
