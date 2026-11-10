import { DAYS, toHHMM } from '@shared/time.js';
import { CONGESTION } from '@shared/stopTrips.js';
import { reasonText } from '@shared/liveStatus.js';
import { STATUS } from '@shared/recommend.js';
import { routeColor } from '../lib/palette.js';
import { Button, IconAlert, IconBus, IconChevron, IconPin, IconStop, SourceTag } from './ui.jsx';
import { StopSearch } from './StopPicker.jsx';

const TONE = {
  ok: 'bg-go-soft text-go', warn: 'bg-caution-soft text-caution', danger: 'bg-stop-soft text-stop', muted: 'bg-surface text-ink-muted',
};
const DOT = { ok: 'bg-go-dot', warn: 'bg-caution-dot', danger: 'bg-stop-dot', muted: 'bg-ink-muted' };

/** 초록·노랑·빨강 상태 태그(색 + 글자로 함께 표시) */
export function Signal({ tone, children }) {
  return (
    <span data-tone={tone} className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-bold ${TONE[tone]}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${DOT[tone]}`} aria-hidden="true" />{children}
    </span>
  );
}

function StopChip({ stop, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-label={`탑승 정류장 ${stop.name} 바꾸기`} className="flex h-11 w-full items-center gap-2 rounded-2xl border border-line bg-panel px-3.5 text-left shadow-card transition-colors hover:border-primary-line short:h-10">
      <IconStop className="h-5 w-5 shrink-0 text-primary" />
      <span className="shrink-0 text-[13px] font-semibold text-ink-muted">탑승</span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{stop.name}</span>
      <span className="flex shrink-0 items-center text-[13px] font-semibold text-primary">바꾸기<IconChevron className="h-4 w-4" /></span>
    </button>
  );
}

/** ②·③ 정보 카드: 작은 머리말 + 상태 태그 / 큰 한 줄 / 짧은 보조 줄 */
function InfoCard({ icon, caption, tag, children, sub, label }) {
  return (
    <section aria-label={label} className="min-w-0 rounded-3xl border border-line bg-panel px-5 pb-4 pt-3.5 shadow-card sm:pb-5 sm:pt-4 short:pb-3.5 short:pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-muted">{icon}{caption}</span>
        {tag}
      </div>
      <p className="mt-1.5 text-[22px] font-bold leading-tight tracking-[-0.01em] sm:text-[24px] short:mt-1 short:text-[21px]">{children}</p>
      {sub && <p className="mt-1 truncate text-[14px] text-ink-muted">{sub}</p>}
    </section>
  );
}

function Message({ title, children, action }) {
  return (
    <section className="grid grid-cols-1 gap-2 rounded-3xl border border-line bg-panel px-6 py-7 shadow-card">
      <p className="text-[22px] font-bold leading-snug">{title}</p>
      {children && <p className="text-[15px] text-ink-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </section>
  );
}

const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const pad = (n) => String(n).padStart(2, '0');
const clockOfMin = (m) => { const t = Math.floor(m * 60); return `${pad(Math.floor(t / 3600) % 24)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`; };
const agoText = (sec) => (sec >= 90 ? `${Math.round(sec / 60)}분` : `${Math.max(1, Math.round(sec))}초`);

/** 카드 아래 데이터 출처 줄: [서울시 실시간] / [서울시 실시간 · 잠시 전 값] / [예시 데이터 · 이유] */
function DataLine({ live }) {
  const at = live?.at ? CLOCK.format(new Date(live.at)) : Number.isFinite(live?.fetchedMin) ? clockOfMin(live.fetchedMin) : null;
  let tag = <SourceTag source="seoul" />, text = at ? `${at} 갱신` : '', warn = false;
  if (live?.status === 'error') { tag = null; text = '서버에 연결하지 못했어요 · 다시 연결하는 중'; warn = true; }
  else if (live?.status === 'stale') { tag = <SourceTag source={live.source} reason={live.reason} stale />; text = `서버 연결이 끊겨 ${at} 정보를 보여 주는 중`; warn = true; }
  else if (live?.source === 'mock') { tag = <SourceTag source="mock" reason={live.reason} />; text = '실제 버스 운행 정보가 아니에요'; }
  else if (live?.stale) { tag = <SourceTag source="seoul" stale />; text = `서울시 연결이 잠시 끊겨 ${agoText(live.ageSec || 0)} 전 정보예요`; warn = true; }
  return (
    <div data-testid="data-line" className={`flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-1 text-xs ${warn ? 'text-caution' : 'text-ink-muted'}`}>
      {tag}{text && <span>{text}</span>}
    </div>
  );
}

/** 예시 데이터로 바뀌었을 때 맨 위 안내(점선) */
function FallbackNotice({ reason }) {
  return (
    <section aria-label="예시 데이터 안내" data-testid="fallback-notice" className="flex items-start gap-2 rounded-2xl border border-dashed border-ink-muted/70 bg-surface px-3.5 py-2 text-[13px] leading-snug text-ink-muted">
      <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-caution" />
      <p><b className="font-semibold text-ink">실시간 연결 실패 · 예시 데이터로 표시 중</b>{reason ? ` (${reasonText(reason)})` : ''}<span className="hidden sm:inline"> — 실제 버스와 다를 수 있고, 연결되면 자동으로 바뀌어요.</span></p>
    </section>
  );
}
const nextDayText = (c) => (c ? `다음 등교: ${DAYS[c.day]}요일 ${c.start} ${c.name}` : '시간표 탭에서 수업을 등록해 주세요.');

/**
 * 홈: ① 출발 추천 시각 ② 실시간 버스 도착 + 도로 정체 ③ 강의실 도착 예정 + 상태.
 * 계산 과정(도보·차내 시간 내역, 공식)은 보여 주지 않습니다.
 */
export default function HomeScreen({ mode, syncing, stop, rec, live, now, nextClass, hasClasses, onPickStop, onSelectStop, onGoTimetable }) {
  if (!stop && syncing) return <div className="mx-auto h-48 w-full max-w-[560px] animate-pulse rounded-3xl bg-line/70" aria-busy="true" aria-label="불러오는 중" />;
  if (!stop) {
    return (
      <div className="mx-auto grid w-full max-w-[560px] grid-cols-1 gap-4">
        <section className="grid grid-cols-1 gap-4 rounded-3xl border border-line bg-panel px-5 py-6 shadow-card sm:px-6">
          <div>
            <h1 className="text-[24px] font-bold leading-snug">어느 정류장에서 버스를 타세요?</h1>
            <p className="mt-1 text-[15px] text-ink-muted">집 주소는 필요 없어요. 매일 타는 정류장 하나만 고르면 출발 시각을 알려 드려요.</p>
          </div>
          <StopSearch mode={mode} onSelect={onSelectStop} />
        </section>
      </div>
    );
  }

  const mock = live?.source === 'mock'; // 서울시 실시간 대신 예시 데이터

  let body;
  if (rec?.state === 'no-class') {
    body = hasClasses
      ? <Message title={now.weekday > 4 ? '주말이에요. 등교할 수업이 없어요' : '오늘은 등교할 수업이 없어요'}>{nextDayText(nextClass)}</Message>
      : <Message title="시간표를 등록해 주세요" action={<Button variant="primary" onClick={onGoTimetable}>시간표 등록하기</Button>}>첫 수업 시각에 맞춰 출발 시각을 계산해요.</Message>;
  } else if (rec?.state === 'started') {
    body = <Message title={`${rec.cls.name} 수업이 시작됐어요`}>{nextDayText(nextClass)}</Message>;
  } else if (!rec || rec.state === 'no-trip') {
    if (live?.status === 'loading' || live?.status === 'idle') {
      body = <div className="grid grid-cols-1 gap-4" aria-busy="true" aria-label="불러오는 중">{[196, 124, 124].map((h, i) => <div key={i} className="animate-pulse rounded-3xl bg-line/70" style={{ height: h }} />)}</div>;
    } else if (live?.status === 'error') {
      body = <Message title="실시간 버스 정보를 불러오지 못했어요">{live.error} 잠시 뒤 자동으로 다시 시도해요.</Message>;
    } else {
      body = (
        <Message title="여기서 국민대로 가는 버스를 찾지 못했어요" action={<Button variant="primary" onClick={onPickStop}>정류장 바꾸기</Button>}>
          지금 이 정류장에 도착 예정인 버스 중 국민대 정문·후문 정류장을 지나는 노선이 없어요.
        </Message>
      );
    }
  } else {
    const p = rec.pick, t = p.trip, st = STATUS[rec.status], cg = CONGESTION[rec.nextBus.congestion] || CONGESTION.unknown;
    // 정체 원인(도로 이름)은 보통·혼잡일 때만 짧게 덧붙임 — 표에 없는 구간(정류장 이름)은 생략
    const cause = t.cause && !t.cause.includes('→') && ['normal', 'heavy'].includes(rec.nextBus.congestion) ? `${t.cause} 정체 · ` : '';
    const card = mock ? 'border-2 border-dashed border-ink-muted/60 bg-panel text-ink' : `text-white ${rec.status === 'late' ? 'bg-stop' : 'bg-primary'}`;
    const left = Math.max(1, Math.ceil(p.departMin - now.minutes - 1e-6)); // 상단 시각(분 내림) + 남은 분 = 출발 시각
    const leftText = left >= 60 ? `${Math.floor(left / 60)}시간 ${left % 60}분 뒤` : `${left}분 뒤`;
    const n = rec.nextBus.inMin;
    const arrival = n == null ? '도착 정보 없음' : n < 1 ? '곧 도착' : `${Math.round(n)}분 후 도착`;
    body = (
      <>
        <section aria-label="출발 추천" data-source={mock ? 'mock' : 'seoul'} className={`min-w-0 rounded-3xl px-5 pb-5 pt-4 shadow-card sm:px-6 sm:pb-6 sm:pt-5 short:pb-4 short:pt-3 ${card}`}>
          <div className="flex items-center justify-between gap-3">
            <span className={`text-[15px] font-bold ${mock ? 'text-ink-muted' : 'text-white/90'}`}>{mock ? '출발 추천 · 예시 데이터 기준' : rec.status === 'late' ? '지각 위험 · 서두르세요' : '출발 추천'}</span>
            {!rec.departNow && <span className={`rounded-full px-3 py-1 text-[13px] font-semibold ${mock ? 'bg-surface text-ink-muted' : 'bg-white/15'}`}>{leftText}</span>}
          </div>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5">
            {rec.departNow
              ? <span className="text-[48px] font-bold leading-none tracking-tight sm:text-[56px]">지금 출발</span>
              : <><span className="num text-[72px] font-bold leading-[0.85] tracking-tight sm:text-[80px] short:text-[62px]">{toHHMM(p.departMin)}</span><span className="text-[24px] font-bold">출발</span></>}
          </p>
          <p className="mt-4 flex items-center gap-1.5 text-[17px] font-semibold sm:mt-5 short:mt-3">
            <span className={`num inline-grid h-7 min-w-[48px] place-items-center rounded-md px-2 text-[17px] font-bold ${mock ? 'text-white' : 'bg-white'}`} style={mock ? { background: routeColor(t.type) } : { color: routeColor(t.type) }}>{t.no}</span>
            <span>번 버스 <span className="num text-[19px]">{toHHMM(p.boardMin)}</span> 탑승</span>
          </p>
        </section>

        <InfoCard label="실시간 버스 도착" icon={<IconBus className="h-4 w-4 text-bus" />} caption={mock ? '버스 도착 (예시)' : '실시간 버스'}
          tag={<Signal tone={cg.tone}>도로 정체 {cg.label}</Signal>}
          sub={`${cause}${rec.nextBus.isPick ? '이 버스를 타면 돼요' : `추천 버스는 ${toHHMM(p.boardMin)} 도착 예정`}`}>
          <span className="num">{t.no}</span>번 버스 {arrival}
        </InfoCard>

        <InfoCard label="강의실 도착 예정" icon={<IconPin className="h-4 w-4 text-primary" />} caption="강의실 도착"
          tag={<Signal tone={st.tone}>{st.label}</Signal>}
          sub={`${rec.cls.name} ${rec.cls.start} 시작 · ${rec.cls.building}${rec.cls.room ? ` ${rec.cls.room}` : ''}`}>
          <span className="num">{toHHMM(p.classArriveMin)}</span> 강의실 도착 예정
        </InfoCard>
      </>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-[560px] grid-cols-1 gap-3 short:gap-2.5">
      <StopChip stop={stop} onClick={onPickStop} />
      {mock && <FallbackNotice reason={live.reason} />}
      {body}
      <DataLine live={live} />
    </div>
  );
}
