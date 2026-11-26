import { useState } from 'react';
import { DAYS, toHHMM } from '@shared/time.js';
import { CONGESTION } from '@shared/stopTrips.js';
import { reasonText } from '@shared/liveStatus.js';
import { STATUS } from '@shared/recommend.js';
import { personalLabel } from '@shared/arrival.js';
import { departProgress, finalTripOf, hhmm, inkOn, legEnds, subwayGap } from '@shared/transitPlan.js';
import { routeColor } from '../lib/palette.js';
import { Button, IconAlert, IconBus, IconChevron, IconIdCard, IconPin, IconRoute, IconStop, IconWalk, SampleTag, SourceTag } from './ui.jsx';
import { ArriveButton, ArrivalPrompt, ArrivedCard } from './Arrival.jsx';
import IncidentStrip from './IncidentStrip.jsx';
import WhyStrip, { GapStrip } from './WhyStrip.jsx';
import RouteCard from './RouteCard.jsx';

const TONE = {
  ok: 'bg-go-soft text-go', warn: 'bg-caution-soft text-caution', danger: 'bg-stop-soft text-stop', muted: 'bg-surface text-ink-muted',
};
const DOT = { ok: 'bg-go-dot', warn: 'bg-caution-dot', danger: 'bg-stop-dot', muted: 'bg-ink-muted' };
const TONE_TEXT = { ok: 'text-go', warn: 'text-caution', danger: 'text-stop', muted: 'text-ink-muted' };

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

/* ── v2.0 출발지 환승 경로 모드 ── */
/** 출발지 칩: 출발지 → 국민대 · 바꾸기(설정 · 출발 방식으로) */
function OriginChip({ origin, onClick }) {
  return (
    <button type="button" onClick={onClick} data-testid="origin-chip" aria-label={`출발지 ${origin?.name || ''} · 환승 경로 바꾸기`} className="flex h-11 w-full items-center gap-2 rounded-2xl border border-line bg-panel px-3.5 text-left shadow-card transition-colors hover:border-primary-line short:h-10">
      <IconRoute className="h-5 w-5 shrink-0 text-primary" />
      <span className="shrink-0 text-[13px] font-semibold text-ink-muted">출발</span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{origin?.name || '출발지'}<span className="font-semibold text-ink-muted"> → 국민대</span></span>
      <span className="flex shrink-0 items-center text-[13px] font-semibold text-primary">바꾸기<IconChevron className="h-4 w-4" /></span>
    </button>
  );
}

/** v2.1 경로를 못 찾아 가까운 국민대행 정류장으로 직행 안내 중 → 기억해 둔 출발지로 [경로 다시 찾기] */
function RetryNotice({ retry, onClick }) {
  return (
    <section aria-label="환승 경로 다시 찾기" data-testid="retry-notice" className="flex items-center gap-2 rounded-2xl border border-dashed border-primary-line bg-primary-soft px-3.5 py-2 text-[13px] leading-snug text-ink">
      <IconRoute className="h-4 w-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">환승 경로 대신 <b className="font-semibold">가까운 정류장 직행</b>으로 안내 중이에요{retry?.origin?.name ? <span className="text-ink-muted"> · {retry.origin.name}</span> : null}</p>
      <Button size="sm" onClick={onClick} data-testid="retry-search">경로 다시 찾기</Button>
    </section>
  );
}

/** 환승 경로 모드인데 아직 경로를 고르지 않음 → 직행으로 안내 중 */
function TransitPending({ onClick }) {
  return (
    <section aria-label="환승 경로 안내" data-testid="transit-pending" className="flex items-center gap-2 rounded-2xl border border-dashed border-primary-line bg-primary-soft px-3.5 py-2 text-[13px] leading-snug text-ink">
      <IconRoute className="h-4 w-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">출발지 환승 경로를 아직 고르지 않아 <b className="font-semibold">단일 정류장 직행</b>으로 안내해요</p>
      <Button size="sm" onClick={onClick}>경로 고르기</Button>
    </section>
  );
}

/**
 * v2.6.0 환승 구간 종류별 이름 · 실시간 문구 — 지금은 지하철만.
 * v2.7.0 중간 환승 버스는 화면 미리보기 승인 뒤 여기에 bus(예: '환승 버스' · 받은 곳에 따라 서울시/경기도)를 더함 — 없는 종류는 말하지 않음
 */
const MID_TEXT = {
  subway: { name: '환승 지하철', live: (m) => `환승 지하철 실시간(${m.line || '지하철'})`, has: (m) => (m.trains?.length || 0) > 0 },
};
/** v2.6.0 환승 구간 한 마디('출발했어요!' 뒤 서버가 알려 준 상태) — 출발 전 · 창이 지남 · 끔 · 예시는 말하지 않음 */
function midPart(m) {
  const t = MID_TEXT[m?.kind];
  if (!t) return null;
  if (m.source === 'seoul') return t.has(m) ? t.live(m) : `${t.name} 도착 정보 없음(배차로 예상)`;
  if (m.source === 'skip') return m.reason === 'not-yet' ? `${t.name} 실시간은 탑승 15분 전부터` : null;
  if (m.source === 'nodata') return m.reason === 'line' || m.reason === 'off' ? `${t.name} 실시간 없음(배차로 예상)` : `${t.name} 도착 정보 없음(배차로 예상)`;
  if (m.source === 'off' || m.source === 'sample') return null;
  return `${t.name} 실시간 못 받음(배차로 예상)`; // error · cap(오늘 환승 구간 몫 · 전체 상한) · quota
}
/** v2.6.0 '출발했어요!' 뒤 첫 탑승 구간을 이미 탔는지(누른 시각으로 계산한 예상) — 탔으면 첫 구간 글 · 배지는 빼고 다음 구간만 */
export function firstBoarded(rec, route, nowMin) {
  if (!rec?.departed || !route) return false;
  const st = departProgress(rec, nowMin)?.byLeg?.[legEnds(route).first];
  return st === 'done' || st === 'riding';
}
/** 첫 탑승 · 환승 지하철(v2.6.0 — '출발했어요!' 뒤에만) · 마지막 국민대행 버스가 어디서 온 값인지(실시간 · 출발 30분 전부터 · 못 받음 → 배차로 예상) — v2.5.0 경기도 정류장 첫 버스 */
function transitParts(rt, firstDone = false, departed = false) {
  const parts = [], f = firstDone ? null : rt?.first, l = rt?.final;
  if (f?.kind === 'subway') {
    parts.push(f.source === 'seoul' ? '첫 지하철 실시간' : f.source === 'skip' ? '첫 지하철 실시간은 출발 30분 전부터'
      : f.source === 'nodata' ? '첫 지하철 실시간 없음(배차로 예상)' : '첫 지하철 실시간 못 받음(배차로 예상)');
  } else if (f?.kind === 'bus') {
    parts.push(f.source === 'seoul' ? (f.buses?.length ? '첫 버스 실시간' : '첫 버스 도착 정보 없음(배차로 예상)')
      : f.source === 'gyeonggi' ? (f.buses?.length ? '첫 버스 실시간(경기도)' : '첫 버스 도착 정보 없음(배차로 예상)')
        : f.source === 'skip' ? '첫 버스 실시간은 출발 30분 전부터' : '첫 버스 실시간 못 받음(배차로 예상)');
  }
  const mp = departed ? midPart(rt?.mid) : null; // 출발 기록을 지운 직후 다음 갱신 전까지 남은 값은 말하지 않음(계산에도 쓰지 않음)
  if (mp) parts.push(mp);
  if (l) parts.push(l.source === 'seoul' ? '국민대행 버스 실시간' : '국민대행 버스 실시간 못 받음(배차로 예상)');
  return parts;
}
/** 환승 경로 카드 오른쪽 위 태그: 실시간 반영 · 예상(실시간 전) · 예상 · 예시 데이터 — v2.6.0 첫 구간을 이미 탔으면 '실시간 전'은 쓰지 않음 */
export function transitTag(tl, rec, firstDone = false) {
  if (tl?.sample) return 'sample';
  const used = rec?.state === 'ok' && rec.pick.legs.some((s) => s.kind !== 'walk' && s.src === 'live');
  if (used) return 'live';
  return !firstDone && tl?.rt?.first?.source === 'skip' ? 'std' : null;
}
/** 환승 경로 모드 카드 아래 데이터 출처 줄(v2.2 '출발했어요!' 뒤에는 앞에 'HH:MM 출발 기준') */
function TransitDataLine({ tl, departedMin = null, firstDone = false }) {
  const dep = Number.isFinite(departedMin) ? `${hhmm(departedMin)} 출발 기준 · ` : '';
  if (tl?.sample) {
    return (
      <div data-testid="data-line" data-mode="transit" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-1 text-xs text-ink-muted">
        <SampleTag>예시 데이터 · 실시간 아님</SampleTag><span>{dep}ODsay · 서울시 형식의 예시 응답이에요</span>
      </div>
    );
  }
  const at = tl?.at ? CLOCK.format(new Date(tl.at)) : null, parts = transitParts(tl?.rt, firstDone, Boolean(dep));
  if (dep) parts.unshift(dep.slice(0, -3));
  let tag = null, text, warn = false;
  if (!tl || tl.status === 'idle' || tl.status === 'loading') text = '실시간 정보를 불러오는 중 · 그동안 배차간격으로 예상해요';
  else if (tl.status === 'error') { text = '서버에 연결하지 못했어요 · 배차간격으로 예상해 보여 주는 중'; warn = true; }
  else {
    // v2.5.0 '경기도 실시간' 배지는 첫 버스를 경기도 도착 정보로 계산할 때만(마지막 국민대행 버스는 지금처럼 서울시)
    // v2.6.0 환승 지하철도 서울시 자료 → '서울시 실시간'에 포함 · 출발 뒤 첫 구간을 이미 탔으면 첫 구간 배지는 빼고
    //   (v2.7.0 중간 환승 버스가 경기도 도착 정보면 mid.source 'gyeonggi' → 아래 gg에 더함)
    const f = firstDone ? null : tl.rt?.first;
    const seoul = f?.source === 'seoul' || tl.rt?.final?.source === 'seoul' || (Boolean(dep) && tl.rt?.mid?.source === 'seoul');
    const gg = f?.source === 'gyeonggi' && f.buses?.length > 0;
    if (seoul || gg) tag = <>{seoul && <SourceTag source="seoul" stale={tl.status === 'stale'} />}{gg && <SourceTag source="gyeonggi" stale={tl.status === 'stale'} />}</>;
    text = tl.status === 'stale' ? `서버 연결이 끊겨 ${at} 정보를 보여 주는 중 · ${parts.join(' · ')}` : `${parts.join(' · ')}${at ? ` · ${at} 갱신` : ''}`;
    warn = tl.status === 'stale';
  }
  return (
    <div data-testid="data-line" data-mode="transit" className={`flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-1 text-center text-xs ${warn ? 'text-caution' : 'text-ink-muted'}`}>
      {tag}<span>{text}</span>
    </div>
  );
}
/* ── v2.2 '출발했어요!' ── */
const stationLabel = (name, kind) => (kind === 'subway' && name && !/역$/.test(name) ? `${name}역` : name || '');
/** 출발 카드 안 흰 버튼 — 추천 출발 1시간 전부터 수업 시작 전까지(canDepart). 누르면 그 시각에 나갔다고 보고 끝까지 계산 */
function DepartButton({ late, onClick, error }) {
  return (
    <div className="mt-4 sm:mt-5 short:mt-3" data-testid="depart-box">
      <button type="button" data-testid="depart-button" onClick={onClick}
        className={`flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white text-[17px] font-bold shadow-[0_2px_10px_rgba(10,30,80,.18)] transition-colors hover:bg-white/90 short:h-11 ${late ? 'text-stop' : 'text-primary'}`}>
        <IconWalk className="h-[21px] w-[21px]" />출발했어요!
      </button>
      <p className="mt-2 text-[12.5px] leading-snug text-white/85 short:mt-1.5">집을 나서면 눌러 주세요 · 이 시각 기준으로 환승 버스 실시간을 맞춰요</p>
      {error && <p role="status" data-testid="depart-error" className="mt-1.5 text-[12.5px] font-semibold leading-snug text-white">출발을 기록하지 못했어요 · {error}</p>}
    </div>
  );
}
/** 누른 뒤 '다음에 탈 것' 옆 출처: 실시간 · N분 후 / 배차 간격 예상 / 예상 (미리보기는 '예시') */
function HeroSource({ s, nowMin, late, sample }) {
  if (s.src === 'live') {
    const left = s.board - nowMin;
    const when = left >= 0 ? ` · ${left < 1 ? '곧' : `${Math.round(left)}분 후`}` : '';
    return (
      <span data-testid="depart-next-src" data-src="live" className={`inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md bg-white px-[7px] text-[12px] font-bold ${late ? 'text-stop' : 'text-primary-active'}`}>
        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />{sample ? '예시' : '실시간'}{when}
      </span>
    );
  }
  return <span data-testid="depart-next-src" data-src={s.src} className="inline-flex h-[22px] shrink-0 items-center rounded-md bg-white/20 px-[7px] text-[12px] font-bold text-white">{s.src === 'term' ? '배차 간격 예상' : '예상'}</span>;
}
/**
 * ① 누른 뒤 출발 카드(이동 중): 다음에 탈 것(시각 · 노선 · 역/정류장 · 출처)을 크게, 다 탔으면 하차 · 강의실 도착.
 * 위치는 모름 → 누른 시각으로 계산한 예상. 아래 줄에 [잘못 눌렀어요](한 번 더 물은 뒤 지움)
 */
function DepartedHero({ rec, now, progress, route, dep, sample }) {
  const [confirm, setConfirm] = useState(false);
  const late = rec.status === 'late', D = rec.pick.departMin;
  const nx = progress?.next || null, leg = nx ? route.legs[nx.i] : null;
  const left = nx ? Math.max(1, Math.ceil(nx.board - now.minutes - 1e-6)) : null;
  const leftText = left == null ? null : left >= 60 ? `${Math.floor(left / 60)}시간 ${left % 60}분 뒤` : `${left}분 뒤`;
  let line;
  if (nx && leg) {
    const bus = leg.kind === 'bus', light = inkOn(leg.color) !== '#FFFFFF';
    const no = bus ? nx.vehicle || leg.no : leg.line;
    const where = bus ? `번 버스 · ${leg.from?.name || ''}` : `${stationLabel(leg.from?.name, 'subway')}${leg.way ? ` · ${leg.way} 방면` : ''}`;
    line = (
      <p data-testid="depart-next" className="mt-4 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[15px] font-semibold sm:mt-5 short:mt-3">
        <span className="num inline-grid h-7 min-w-[48px] shrink-0 place-items-center rounded-md px-2 text-[16px] font-bold" style={light ? { background: leg.color, color: inkOn(leg.color) } : { background: '#FFFFFF', color: leg.color }}>{no}</span>
        <span className="min-w-0 truncate">{where}</span>
        <HeroSource s={nx} nowMin={now.minutes} late={late} sample={sample} />
      </p>
    );
  } else {
    const last = progress?.last, lastLeg = last ? route.legs[last.i] : null;
    line = (
      <p data-testid="depart-next" className="mt-4 min-w-0 text-[15px] font-semibold sm:mt-5 short:mt-3">
        {lastLeg ? <>{stationLabel(lastLeg.to?.name, lastLeg.kind)} <span className="num text-[17px]">{hhmm(last.end)}</span> 하차 · </> : null}강의실까지 걸어서 {Math.round(rec.pick.walkInMin)}분{rec.personalMin ? ` · 내 걸음 ${personalLabel(rec.personalMin)}` : ''}
      </p>
    );
  }
  return (
    <section aria-label="이동 중" data-testid="departed-hero" data-mode="transit" className={`min-w-0 rounded-3xl px-5 pb-4 pt-4 text-white shadow-card sm:px-6 sm:pt-5 short:pb-3.5 short:pt-3 ${late ? 'bg-stop' : 'bg-primary'}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-bold text-white/90">{late ? '지각 위험 · 이동 중' : `이동 중 · ${hhmm(D)} 출발`}</span>
        {leftText && <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-[13px] font-semibold">{leftText}</span>}
      </div>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5">
        <span className="num text-[72px] font-bold leading-[0.85] tracking-tight sm:text-[80px] short:text-[62px]">{hhmm(nx ? nx.board : rec.pick.classArriveMin)}</span>
        <span className="text-[24px] font-bold">{nx ? '탑승' : '강의실 도착'}</span>
      </p>
      {line}
      {confirm ? (
        <div className="mt-3.5 grid gap-2 border-t border-white/25 pt-3" data-testid="depart-confirm">
          <p className="text-[14px] font-bold">출발 기록을 지울까요?</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="depart-undo-yes" disabled={dep.busy} onClick={async () => { if (await dep.undo()) setConfirm(false); }}
              className={`inline-flex h-[34px] items-center rounded-[10px] bg-white px-3.5 text-[13.5px] font-bold disabled:opacity-70 ${late ? 'text-stop' : 'text-primary'}`}>{dep.busy ? '지우는 중…' : '출발 기록 지우기'}</button>
            <button type="button" onClick={() => setConfirm(false)} className="inline-flex h-[34px] items-center rounded-[10px] border border-white/55 px-3.5 text-[13.5px] font-semibold">아니요</button>
          </div>
        </div>
      ) : (
        <div className="mt-3.5 flex items-center justify-between gap-2.5 border-t border-white/25 pt-2.5 text-[12.5px] text-white/90">
          <span className="min-w-0" data-testid="depart-note">{dep.record?.pending ? `${hhmm(D)} 출발 · 서버에 보내는 중(연결되면 자동으로)` : `${hhmm(D)} 출발 기준으로 계산 중`}</span>
          <button type="button" data-testid="depart-undo" onClick={() => setConfirm(true)} className="shrink-0 font-semibold underline underline-offset-2">잘못 눌렀어요</button>
        </div>
      )}
      {dep.error && <p role="status" className="mt-1.5 text-[12.5px] font-semibold leading-snug text-white">{dep.error}</p>}
    </section>
  );
}

/** ① 출발 추천(환승): 큰 출발 시각 + 첫 탑승(노선 색 배지 · 탑승 시각 · 역/정류장) + v2.2 [출발했어요!] */
function TransitDepart({ rec, now, dep = null }) {
  const p = rec.pick, t = p.trip;
  const left = Math.max(1, Math.ceil(p.departMin - now.minutes - 1e-6));
  const leftText = left >= 60 ? `${Math.floor(left / 60)}시간 ${left % 60}분 뒤` : `${left}분 뒤`;
  const light = t.ink !== '#FFFFFF'; // 밝은 노선 색(노랑 등)은 색 배지 + 진한 글자
  const where = t.kind === 'subway' && t.stop && !/역$/.test(t.stop) ? `${t.stop}역` : t.stop;
  return (
    <section aria-label="출발 추천" data-mode="transit" data-source={p.live ? 'live' : 'std'} className={`min-w-0 rounded-3xl px-5 pb-5 pt-4 text-white shadow-card sm:px-6 sm:pb-6 sm:pt-5 short:pb-4 short:pt-3 ${rec.status === 'late' ? 'bg-stop' : 'bg-primary'}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-bold text-white/90">{rec.status === 'late' ? '지각 위험 · 서두르세요' : '출발 추천 · 환승 경로'}</span>
        {!rec.departNow && <span className="rounded-full bg-white/15 px-3 py-1 text-[13px] font-semibold">{leftText}</span>}
      </div>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5">
        {rec.departNow
          ? <span className="text-[48px] font-bold leading-none tracking-tight sm:text-[56px]">지금 출발</span>
          : <><span className="num text-[72px] font-bold leading-[0.85] tracking-tight sm:text-[80px] short:text-[62px]">{hhmm(p.departMin)}</span><span className="text-[24px] font-bold">출발</span></>}
      </p>
      <p className="mt-4 flex min-w-0 items-center gap-1.5 text-[17px] font-semibold sm:mt-5 short:mt-3">
        <span data-testid="first-badge" className="num inline-grid h-7 min-w-[48px] shrink-0 place-items-center rounded-md px-2 text-[16px] font-bold" style={light ? { background: t.color, color: t.ink } : { background: '#FFFFFF', color: t.color }}>{t.no}</span>
        <span className="shrink-0">{t.kind === 'bus' ? '번 버스 ' : ''}<span className="num text-[19px]">{hhmm(p.boardMin)}</span> 탑승</span>
        <span className="min-w-0 truncate text-[14px] font-medium text-white/80">· {where}</span>
      </p>
      {dep?.can && <DepartButton late={rec.status === 'late'} onClick={dep.press} error={dep.error} />}
    </section>
  );
}

/**
 * 홈: ① 출발 추천 시각 ② 실시간 버스 도착 + 도로 정체 (+ 경로 주변 날씨 · 돌발정보 한 줄) ③ 강의실 도착 예정 + 상태.
 * 계산 과정(도보·차내 시간 내역, 공식)은 보여 주지 않습니다.
 * 오늘 첫 수업 시작 30분 전 ~ 15분 뒤에는 ③ 카드에 [도착했어요!](상태 태그 자리, 상태는 아랫줄로) → 기록하면 수업이 끝날 때까지 '도착 기록' 카드
 * @param {object} p.arrival  useArrival 결과 + cls(오늘 첫 수업)
 * @param {object} [p.departure]  v2.2 useDeparture 결과 + can(지금 [출발했어요!]를 보여 줄지) — 환승 경로 모드만
 */
export default function HomeScreen({ mode, syncing, stop, rec, live, now, nextClass, hasClasses, arrival, kcardReady, personal, onPickStop, onGoTimetable, transit = null, onOpenTransit, renderFinder = null, departure = null }) {
  const tOn = Boolean(transit?.on); // 출발지 환승 경로 모드(경로를 고른 뒤) — 아니면 정류장 직행
  if (!stop && !tOn && syncing) return <div className="mx-auto h-48 w-full max-w-[560px] animate-pulse rounded-3xl bg-line/70" aria-busy="true" aria-label="불러오는 중" />;
  if (!stop && !tOn) {
    // v2.1 처음 화면: 출발지만 물음(GPS · 역 이름 → 추천 경로 3개). 정류장 직접 고르기는 작은 링크로
    // 찾는 칸은 이 카드 안에, 추천 경로 카드 · 못 찾을 때 안내는 카드 밖(아래)에(좁은 휴대폰에서도 막대가 한 줄로)
    const onboarding = (controls) => (
      <section data-testid="onboarding" className="grid grid-cols-1 gap-4 rounded-3xl border border-line bg-panel px-5 py-6 shadow-card sm:px-6">
        <div>
          <h1 className="text-[24px] font-bold leading-snug">어디서 출발하세요?</h1>
          <p className="mt-1 text-[15px] text-ink-muted">집이나 가까운 역에서 국민대까지 지하철 · 버스 환승 경로를 찾아, 몇 시에 나가면 되는지 알려 드려요.</p>
        </div>
        {controls}
        <p className="text-[13px] text-ink-muted">국민대행 버스를 한 번만 타나요?{' '}
          <button type="button" onClick={onPickStop} data-testid="pick-stop-link" className="inline-flex items-center font-semibold text-primary hover:underline">정류장 직접 고르기<IconChevron className="h-4 w-4" /></button>
        </p>
      </section>
    );
    return (
      <div className="mx-auto grid w-full max-w-[560px] grid-cols-1 gap-4">
        {renderFinder ? renderFinder(onboarding) : onboarding(null)}
      </div>
    );
  }

  const mock = !tOn && live?.source === 'mock'; // 서울시 실시간 대신 예시 데이터(직행 모드)
  const a = arrival || {}, phase = a.phase || null;
  const sending = a.send && (a.send.status === 'saving' || a.send.status === 'pending') ? a.send : null;
  const arrived = Boolean((a.record || sending) && phase && phase !== 'after'); // 기록 뒤 ~ 수업 끝날 때까지
  const canPress = phase === 'window' && !a.record && !sending;
  const cardBtn = (label) => <Button onClick={a.view}><IconIdCard className="h-5 w-5" />{kcardReady ? label : 'K•CARD+ 캡처 등록하기'}</Button>;

  let body;
  if (arrived) {
    body = <ArrivedCard record={a.record} pendingAt={sending?.pressedAt} cls={a.cls} personal={personal} kcardReady={kcardReady} canUndo={a.canUndo} onView={a.view} onUndo={a.undo} />;
  } else if (rec?.state === 'no-class') {
    body = hasClasses
      ? <Message title={now.weekday > 4 ? '주말이에요. 등교할 수업이 없어요' : '오늘은 등교할 수업이 없어요'}>{nextDayText(nextClass)}</Message>
      : <Message title="시간표를 등록해 주세요" action={<Button variant="primary" onClick={onGoTimetable}>시간표 등록하기</Button>}>첫 수업 시각에 맞춰 출발 시각을 계산해요.</Message>;
  } else if (rec?.state === 'started') {
    const title = `${rec.cls.name} 수업이 시작됐어요`;
    if (phase === 'window') {
      body = <Message title={title} action={<ArriveButton size="lg" onClick={a.press} busy={a.busy} />}>강의실에 도착했으면 눌러 주세요 · {toHHMM(a.win.closeMin)}(시작 15분 뒤)까지 기록할 수 있어요</Message>;
    } else if (phase === 'class') {
      body = <Message title={title} action={cardBtn('K•CARD+ 보기')}>도착 기록 시간(시작 15분 뒤까지)이 지났어요. 수업 중에도 K•CARD+는 볼 수 있어요.</Message>;
    } else {
      body = <Message title={title}>{nextDayText(nextClass)}{a.record ? ` · 오늘 ${toHHMM(Math.floor(a.record.arriveMin + 1e-9))} 도착 기록(내 걸음 ${personalLabel(personal?.offsetMin)})` : ''}</Message>;
    }
  } else if (!rec || rec.state === 'no-trip') {
    if (tOn) {
      body = <Message title="저장한 환승 경로를 읽지 못했어요" action={<Button variant="primary" onClick={() => onOpenTransit('transit')}>경로 다시 고르기</Button>}>설정 · 출발 방식에서 출발지를 다시 검색해 주세요.</Message>;
    } else if (live?.status === 'loading' || live?.status === 'idle') {
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
  } else if (rec.mode === 'transit') {
    // 환승 경로: ① 출발 추천(첫 탑승) ③ 강의실 도착(상태 · 도착했어요!) ② 환승 경로 카드(타임라인 · 실시간) — 첫 화면에 출발 · 도착이 함께 보이게
    const p = rec.pick, st = STATUS[rec.status];
    const classLine = `${rec.cls.name} ${rec.cls.start} 시작 · ${rec.cls.building}${rec.cls.room ? ` ${rec.cls.room}` : ''}`;
    // v2.1 '왜 늦나요?': 직행과 같은 기준 — 계산이 고른 마지막 국민대행 버스가 보통 · 혼잡이면 그 버스의 설명, 아니면 경로 주변 공사 · 비/눈(없으면 안 나옴)
    //   + 환승에만: 첫 지하철 열차 간격이 배차간격보다 3분 이상 길면 기본 안내 한 줄
    const rt = transit.live?.rt, ft = finalTripOf(transit.route, rec, rt), gap = subwayGap(transit.route, rec, rt, now.minutes);
    const strip = ft?.explain && ['normal', 'heavy'].includes(ft.congestion)
      ? <WhyStrip trip={ft} why={ft.explain} delayMin={ft.delayMin} data={rt?.incidents} weather={rt?.weather} who={`마지막 버스 ${ft.no}번`} />
      : <IncidentStrip data={rt?.incidents} weather={rt?.weather} congestion={ft?.congestion} />;
    // v2.2 '출발했어요!' 뒤: 이동 중 카드 + 경로 카드에 지남 · 타는 중 · 다음(누른 시각으로 계산한 예상)
    const progress = rec.departed ? departProgress(rec, now.minutes) : null;
    body = (
      <>
        {rec.departed && departure
          ? <DepartedHero rec={rec} now={now} progress={progress} route={transit.route} dep={departure} sample={Boolean(transit.live?.sample)} />
          : <TransitDepart rec={rec} now={now} dep={departure} />}
        {strip}
        {gap && <GapStrip gap={gap} />}
        <InfoCard label="강의실 도착 예정" icon={<IconPin className="h-4 w-4 text-primary" />}
          caption={<>강의실 도착{rec.personalMin ? <span data-testid="personal-hint" className="font-normal"> · 내 걸음 {personalLabel(rec.personalMin)}</span> : null}</>}
          tag={canPress ? <ArriveButton onClick={a.press} busy={a.busy} /> : <Signal tone={st.tone}>{st.label}</Signal>}
          sub={canPress
            ? <><b data-tone={st.tone} className={`font-semibold ${TONE_TEXT[st.tone]}`}>{st.label}</b> · {classLine}</>
            : classLine}>
          <span className="num">{hhmm(p.classArriveMin)}</span> 강의실 도착 예정
        </InfoCard>
        <RouteCard route={transit.route} plan={rec} badge="내 경로" liveTag={transitTag(transit.live, rec, firstBoarded(rec, transit.route, now.minutes))} nowMin={now.minutes} testId="transit-route" sample={Boolean(transit.live?.sample)} progress={progress?.byLeg || null} />
      </>
    );
  } else {
    const p = rec.pick, t = p.trip, st = STATUS[rec.status], cg = CONGESTION[rec.nextBus.congestion] || CONGESTION.unknown;
    // 정체 원인(도로 이름)은 보통·혼잡일 때만 짧게 덧붙임 — 표에 없는 구간(정류장 이름)은 생략
    const cause = t.cause && !t.cause.includes('→') && ['normal', 'heavy'].includes(rec.nextBus.congestion) ? `${t.cause} 정체 · ` : '';
    const card = mock ? 'border-2 border-dashed border-ink-muted/60 bg-panel text-ink' : `text-white ${rec.status === 'late' ? 'bg-stop' : 'bg-primary'}`;
    const left = Math.max(1, Math.ceil(p.departMin - now.minutes - 1e-6)); // 상단 시각(분 내림) + 남은 분 = 출발 시각
    const leftText = left >= 60 ? `${Math.floor(left / 60)}시간 ${left % 60}분 뒤` : `${left}분 뒤`;
    const n = rec.nextBus.inMin;
    const arrival = n == null ? '도착 정보 없음' : n < 1 ? '곧 도착' : `${Math.round(n)}분 후 도착`;
    // 버스가 보통 · 혼잡이고 서버가 설명(explain)을 보냈으면 '왜 늦나요?' 한 줄(근거를 펼치면 날씨 · 돌발정보 포함),
    // 아니면 지난번 '경로 주변 날씨 · 돌발정보' 줄. 실시간이면 버스 카드 바로 아래, 예시 데이터면 세 카드 다음(첫 화면 3요소를 밀어내지 않게)
    const classLine = `${rec.cls.name} ${rec.cls.start} 시작 · ${rec.cls.building}${rec.cls.room ? ` ${rec.cls.room}` : ''}`;
    const strip = t.explain && ['normal', 'heavy'].includes(rec.nextBus.congestion)
      ? <WhyStrip trip={t} why={t.explain} delayMin={t.delayMin} data={live?.incidents} weather={live?.weather} />
      : <IncidentStrip data={live?.incidents} weather={live?.weather} congestion={rec.nextBus.congestion} />;
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

        {!mock && strip}

        <InfoCard label="강의실 도착 예정" icon={<IconPin className="h-4 w-4 text-primary" />}
          caption={<>강의실 도착{rec.personalMin ? <span data-testid="personal-hint" className="font-normal"> · 내 걸음 {personalLabel(rec.personalMin)}</span> : null}</>}
          tag={canPress ? <ArriveButton onClick={a.press} busy={a.busy} /> : <Signal tone={st.tone}>{st.label}</Signal>}
          sub={canPress
            ? <><b data-tone={st.tone} className={`font-semibold ${TONE_TEXT[st.tone]}`}>{st.label}</b> · {classLine}</>
            : classLine}>
          <span className="num">{toHHMM(p.classArriveMin)}</span> 강의실 도착 예정
        </InfoCard>
        {mock && strip}
      </>
    );
  }

  // 버스 정보를 못 받는 중(오류 · 노선 없음 · 불러오는 중)이어도 버튼 시간이면 도착 기록은 할 수 있게
  const prompt = canPress && rec?.state !== 'ok' && rec?.state !== 'started' && a.cls ? <ArrivalPrompt cls={a.cls} busy={a.busy} onArrive={a.press} /> : null;
  return (
    <div className="mx-auto grid w-full max-w-[560px] grid-cols-1 gap-3 short:gap-2.5" data-mode={tOn ? 'transit' : 'direct'}>
      {tOn ? <OriginChip origin={transit.origin} onClick={() => onOpenTransit('transit')} /> : <StopChip stop={stop} onClick={onPickStop} />}
      {!tOn && transit?.retry && <RetryNotice retry={transit.retry} onClick={() => onOpenTransit('retry')} />}
      {!tOn && !transit?.retry && transit?.pending && <TransitPending onClick={() => onOpenTransit('transit')} />}
      {!tOn && mock && !arrived && <FallbackNotice reason={live.reason} />}
      {prompt}
      {body}
      {!arrived && (tOn ? rec?.state === 'ok' && <TransitDataLine tl={transit.live} departedMin={rec.departed ? rec.pick.departMin : null} firstDone={firstBoarded(rec, transit.route, now.minutes)} /> : <DataLine live={live} />)}
    </div>
  );
}
