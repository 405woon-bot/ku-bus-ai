import { useId, useState } from 'react';
import { fmtKst, statusText } from '@shared/incidents.js';
import { obsTime, weatherText } from '@shared/weather.js';
import { FREE_FLOW_KMH } from '@shared/explain.js';
import { IconChevron, SampleTag } from './ui.jsx';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
function IconWhy({ className = 'h-[17px] w-[17px]' }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><g {...P}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5" /><path d="M12 16.6v.2" /></g></svg>;
}

const WX_SOURCES = ['kma', 'mock', 'sample'];
const INC_SOURCES = ['seoul', 'mock', 'sample'];
/** 기본 안내로 보여 주는 까닭(펼친 화면 맨 아래) */
const RULE_WHY = {
  'no-key': 'AI 키가 없어 기본 안내로 보여 줘요',
  pending: 'AI 문장을 준비 중이라 잠시 기본 안내로 보여 줘요',
  timeout: 'AI 응답이 늦어 기본 안내로 바꿨어요',
  quota: 'AI 호출 한도를 넘어 기본 안내로 바꿨어요',
  cap: '오늘 AI 호출 상한에 닿아 기본 안내로 보여 줘요',
  ungrounded: 'AI 문장에 사실에 없는 내용이 있어 기본 안내로 바꿨어요',
  causal: 'AI 문장이 원인을 단정해 기본 안내로 바꿨어요', // v2.2.6 원인을 결과에 잇는 말(때문에 · ~해서 · 겹쳐 등)
  format: 'AI 문장 형식이 맞지 않아 기본 안내로 바꿨어요',
  blocked: 'AI가 답하지 않아 기본 안내로 바꿨어요',
  empty: 'AI가 답하지 않아 기본 안내로 바꿨어요',
  auth: 'AI 키를 확인해야 해서 기본 안내로 보여 줘요',
  model: 'AI 모델 이름을 확인해야 해서 기본 안내로 보여 줘요',
};
const TONE = {
  caution: { box: 'border-[#F3DC86] bg-caution-soft', ic: 'bg-[#FBE7A4] text-caution', tx: 'text-[#4A3A10]', b: 'text-[#5C4100]', k: 'text-[#8A7A50]' },
  base: { box: 'border-line bg-panel shadow-card', ic: 'bg-surface text-[#666]', tx: 'text-ink', b: 'text-ink', k: 'text-ink-muted' },
  mock: { box: 'border-[1.5px] border-dashed border-ink-muted/70 bg-surface', ic: 'bg-[#EEE] text-[#777]', tx: 'text-ink', b: 'text-ink', k: 'text-ink-muted' },
};
const TagAI = () => <span className="mr-1 inline-flex h-[17px] items-center rounded px-[5px] align-[1px] text-[10.5px] font-bold tracking-wide text-primary bg-primary-soft">AI</span>;
const TagRule = () => <span className="mr-1 inline-flex h-[17px] items-center rounded border border-[#CFCFCF] px-[5px] align-[1px] text-[10.5px] font-bold text-[#777]">기본 안내</span>;
const TagSample = () => <span className="mr-1 inline-flex h-[17px] items-center rounded border border-dashed border-ink-muted px-[5px] align-[1px] text-[10.5px] font-bold text-ink-muted">예시</span>;

/**
 * 홈 화면 '왜 늦나요?' 한 줄(버스가 보통 · 혼잡일 때, 실시간 버스 카드 바로 아래 — 지난번 '경로 주변' 줄 자리).
 * - 문장은 서버가 확인한 사실만 보고 AI(Gemini)가 쓴 것(태그 AI) 또는 기본 안내(태그 기본 안내). 근거가 없으면 고정 문장(흰 줄)
 * - 오른쪽 +N분은 서버 계산(원활 = 시속 20km로 달렸을 때보다 더 걸리는 시간)
 * - '근거'를 누르면: 서버 계산 · 가장 느린 도로 · 날씨(기상청) · 경로 주변 돌발정보(서울시)를 펼침
 * - 버스가 예시 데이터면(source 'example') 점선 + '예시 데이터 · 실시간 아님', 미리보기 예시(sample)도 '예시' 표시
 * v2.1 환승 경로에서는 마지막 국민대행 버스 기준(who = '마지막 버스 1213번' 한 줄을 위에)
 * @param {{ trip: object, why: { source, text, reason?, facts?, sample?, model? }, delayMin?: number|null, data?: object, weather?: object, who?: string }} p
 */
export default function WhyStrip({ trip, why, delayMin, data, weather, who = '' }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const example = why.source === 'example';
  const ai = why.source === 'gemini';
  const noEvidence = why.reason === 'no-evidence';
  const sample = Boolean(why.sample) || example;
  const toneKey = example ? 'mock' : noEvidence ? 'base' : 'caution';
  const T = TONE[toneKey];
  const heavy = trip.congestion === 'heavy';
  const plus = Number.isFinite(delayMin) && delayMin > 0 ? `+${delayMin}분` : null;
  const text = example ? `${why.text} (예시)` : why.text;
  const facts = why.facts || {};
  const nowMs = data?.nowMs ?? weather?.nowMs ?? Date.now();

  const tag = ai ? <TagAI /> : !noEvidence && !example ? <TagRule /> : null;
  const plusEl = plus && <span data-testid="why-plus" className={`num text-[17px] font-bold leading-none ${heavy ? 'text-stop' : 'text-warn'}`}>{plus}</span>;

  // 근거(펼친 화면) — 숫자는 모두 서버 계산 값 그대로
  const w = weather && WX_SOURCES.includes(weather.source) ? weather : null;
  const items = data && INC_SOURCES.includes(data.source)
    ? (data.items || []).filter((i) => i.where === 'campus' || (i.routes || []).includes(trip.no)).slice(0, 3) : null;
  const incEx = data && ['mock', 'sample'].includes(data.source);
  const wxEx = w && ['mock', 'sample'].includes(w.source);
  const updated = data?.fetchedAt ? fmtKst(Date.parse(data.fetchedAt), nowMs) : '';
  const obs = w ? obsTime(w) : '';
  const kmh = Number.isFinite(trip.kmh) ? Math.round(trip.kmh) : null;
  const route = [`${trip.no}번`, trip.boardName && trip.alightName ? `${trip.boardName} → ${trip.alightName}` : trip.alightName].filter(Boolean).join(' ');
  const foot = example ? '버스 정보가 예시 데이터라 AI를 부르지 않았어요'
    : noEvidence ? '느린 도로 · 비나 눈 · 진행 중인 돌발정보가 확인되지 않아 AI를 부르지 않았어요'
      : ai ? (why.sample ? '실제 서비스에서는 AI(Gemini)가 위 사실만 보고 문장을 써요' : 'AI(Gemini)는 위 사실만 보고 문장을 썼어요')
        : RULE_WHY[why.reason] || 'AI 설명을 쓸 수 없어 기본 안내로 보여 줘요';

  return (
    <section aria-label="왜 늦나요?" data-testid="why-strip" data-why={ai ? 'ai' : example ? 'example' : 'rule'} data-reason={why.reason || ''}
      data-tone={toneKey} className={`min-w-0 rounded-2xl border ${T.box} ${open ? 'px-3.5 pb-3 pt-2.5' : 'py-[9px] pl-3.5 pr-3'}`}>
      {!open ? (
        <button type="button" aria-expanded={false} aria-controls={panelId} onClick={() => setOpen(true)} className="flex w-full min-w-0 items-center gap-2.5 text-left">
          <span className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full ${T.ic}`}><IconWhy /></span>
          <span className="min-w-0 flex-1">
            {who && <span data-testid="why-who" className={`block text-[11.5px] font-semibold leading-snug ${T.k}`}>{who}</span>}
            <span data-testid="why-text" className={`line-clamp-2 text-[14px] leading-[1.42] ${T.tx}`}>
              <b className={`mr-1 font-bold ${T.b}`}>왜 늦나요?</b>{tag}{sample && !example && <TagSample />}{text}
            </span>
            {example && <span className="mt-1 block"><SampleTag>예시 데이터 · 실시간 아님</SampleTag></span>}
          </span>
          <span className="grid shrink-0 justify-items-end gap-[3px]">
            {plusEl}
            <span className="flex items-center whitespace-nowrap text-[12.5px] font-semibold text-primary">근거<IconChevron className="h-3.5 w-3.5" /></span>
          </span>
        </button>
      ) : (
        <div id={panelId}>
          <button type="button" aria-expanded aria-controls={panelId} onClick={() => setOpen(false)} className="flex w-full items-center justify-between gap-2 text-left">
            <span className={`text-[12.5px] font-bold ${T.k}`}>왜 늦나요?{who ? ` · ${who}` : ''} {tag}{sample && !example && <TagSample />}</span>
            <span className="flex items-center text-[12.5px] font-semibold text-primary">접기<IconChevron className="h-3.5 w-3.5 -rotate-90" /></span>
          </button>
          <p data-testid="why-full" className={`mt-1 text-[15px] font-bold leading-[1.45] ${T.tx}`}>{text}</p>
          <ul className="mt-2.5 grid gap-[7px]">
            {Number.isFinite(delayMin) && (
              <Fact k="서버 계산" testid="why-fact-calc">
                <b>{delayMin > 0 ? `원활할 때보다 약 ${delayMin}분 더` : '원활할 때와 거의 같아요'}</b>{delayMin > 0 ? ' 걸려요' : ''}{kmh != null ? ` · 평균 시속 ${kmh}km` : ''}
                <br /><span className="text-[12px] text-ink-muted">{route} · 원활 기준 시속 {FREE_FLOW_KMH}km</span>
              </Fact>
            )}
            <Fact k="가장 느린 도로" testid="why-fact-road">
              {facts['가장 느린 도로']
                ? <><b>{facts['가장 느린 도로']}</b>{facts['느린 정도'] ? ` · ${facts['느린 정도']}` : ''}</>
                : <><b>뚜렷하게 막힌 구간은 없어요</b>{facts['느린 정도'] ? ` · 전체가 ${facts['느린 정도']}` : ''}</>}
            </Fact>
            {w && (
              <Fact k={`날씨 · ${wxEx ? '예시' : `기상청${obs ? ` ${obs} 관측` : ''}`}`} testid="why-fact-weather">
                <b>{w.wet ? weatherText(w) : '강수 없음'}</b>{w.wet ? '' : ' · 비 · 눈 영향 없음'}
              </Fact>
            )}
            {items && (
              <Fact k={`돌발정보 · ${incEx ? '예시' : `서울시${updated ? ` ${updated} 갱신` : ''}`}`} testid="why-fact-incidents">
                {items.length ? items.map((it) => (
                  <span key={it.id || it.title} className="block">
                    <b>{it.label}</b> {it.title} · {it.where === 'route' ? '경로 위' : '국민대 근처'}{it.status === 'soon' ? ` · ${statusText(it, nowMs)}` : ''}
                  </span>
                )) : <b>경로 주변 돌발정보 없음</b>}
              </Fact>
            )}
          </ul>
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] leading-snug text-ink-muted">
            {sample && <><SampleTag>예시 데이터 · 실시간 아님</SampleTag>{!example && <span>미리보기 예시 문장이에요(실제 AI 응답 아님)</span>}</>}
            <span>{foot} · 정체의 원인이라고 확정하는 건 아니에요</span>
          </p>
        </div>
      )}
    </section>
  );
}

function Fact({ k, testid, children }) {
  return (
    <li data-testid={testid} className="rounded-xl border border-line bg-panel px-3 py-2 text-[13px] leading-normal text-ink">
      <span className="block text-[11.5px] font-bold text-[#8A7A50]">{k}</span>
      {children}
    </li>
  );
}

function IconSubway({ className = 'h-[17px] w-[17px]' }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><g {...P}><rect x="6" y="3" width="12" height="14" rx="3" /><path d="M6 11h12M9 20l-2 2M15 20l2 2M9 14.5v.1M15 14.5v.1" /></g></svg>;
}
/**
 * v2.1 환승 경로 첫 지하철: 내가 탈 열차 바로 앞 간격이 배차간격보다 3분 이상 길 때 한 줄(shared/transitPlan.js subwayGap).
 * AI를 부르지 않는 고정 문장(기본 안내) · 오른쪽 +N분 = 실시간 열차 간격 − 평소 배차간격(서울시 실시간 기준)
 */
export function GapStrip({ gap }) {
  return (
    <section aria-label="왜 늦나요? · 첫 지하철" data-testid="gap-strip" className="flex min-w-0 items-center gap-2.5 rounded-2xl border border-line bg-panel py-[9px] pl-3.5 pr-3 shadow-card">
      <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-surface text-[#666]"><IconSubway /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] font-semibold leading-snug text-ink-muted">첫 지하철 {gap.line}</span>
        <span data-testid="gap-text" className="line-clamp-2 text-[14px] leading-[1.42] text-ink">
          <b className="mr-1 font-bold">왜 늦나요?</b><TagRule />{gap.sample && <TagSample />}{gap.text}
        </span>
        {gap.sample && <span className="mt-1 block"><SampleTag>예시 데이터 · 실시간 아님</SampleTag></span>}
      </span>
      <span className="grid shrink-0 justify-items-end gap-[3px]" title={`실시간 열차 간격 ${gap.gapMin}분 · 평소 배차간격 ${gap.intervalMin}분(서울시 실시간 기준)`}>
        <span data-testid="gap-plus" className="num text-[17px] font-bold leading-none text-warn">+{gap.extraMin}분</span>
      </span>
    </section>
  );
}
