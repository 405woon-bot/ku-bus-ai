import { useId, useState } from 'react';
import { fmtKst, headline, periodText, statusText, whereText } from '@shared/incidents.js';
import { obsTime, weatherText, wxHeadline, wxKind } from '@shared/weather.js';
import { IconChevron, SampleTag } from './ui.jsx';

/* 아이콘(24×24 선 아이콘, ui.jsx와 같은 모양새) */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' };
const I = (paths) => function Icon({ className = 'h-4 w-4' }) { return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><g {...P}>{paths}</g></svg>; };
const IconCone = I(<><path d="M9.3 4.5 3.5 19h17L14.7 4.5Z" /><path d="M6.7 11h10.6M5.2 15.2h13.6" /></>);
const IconCrash = I(<><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><path d="M12 9.5v4.5M12 16.8v.2" /></>);
const IconMegaphone = I(<><path d="m3.5 11 17-5v12l-17-4v-3Z" /><path d="M11.4 16.6a3 3 0 1 1-5.6-1.5" /></>);
const IconCloud = I(<><path d="M6.5 17.5A4.5 4.5 0 1 1 8 8.8a5.5 5.5 0 0 1 10.4 2.2 3.3 3.3 0 0 1-.4 6.5H6.5Z" /><path d="M9 20.5v.5M13 20.5v.5" /></>);
const IconRain = I(<><path d="M6.5 15.5A4.5 4.5 0 1 1 8 6.8a5.5 5.5 0 0 1 10.4 2.2 3.3 3.3 0 0 1-.4 6.5H6.5Z" /><path d="M8 18.5v2M12 18.5v2M16 18.5v2" /></>);

const KIND = {
  accident: { Icon: IconCrash, chip: 'border-stop/25 bg-stop-soft text-stop', dot: 'bg-stop-soft text-stop' },
  event: { Icon: IconMegaphone, chip: 'border-primary-line bg-primary-soft text-primary', dot: 'bg-primary-soft text-primary' },
  weather: { Icon: IconCloud, chip: 'border-line bg-surface text-ink', dot: 'bg-surface text-ink-muted' },
  work: { Icon: IconCone, chip: 'border-caution-dot/40 bg-caution-soft text-caution', dot: 'bg-caution-soft text-caution' },
};
const WX = { Icon: IconRain, chip: 'border-[#BFDDF0] bg-[#EAF4FB] text-[#1F6E9E]', dot: 'bg-[#EAF4FB] text-[#1F6E9E]' };
const EXAMPLE = ['mock', 'sample'];

/**
 * 홈 화면 '경로 주변' 한 줄: 비 · 눈이 오면 날씨(기상청 초단기실황) + 경로 주변 돌발정보. 누르면 펼쳐 최대 날씨 1 + 돌발 3건.
 * 둘 다 없으면(맑고 돌발정보 없음) 아무것도 그리지 않습니다.
 * - 길이 막힐 때(보통 · 혼잡) + 비/눈 또는 진행 중인 돌발: 노란 줄 "정체 원인일 수 있어요" — 원인이라고 단정하지 않음
 * - 원활하거나 예정된 것만: 흰 줄(참고)
 * - 예시 데이터(source 'mock' = 버스도 예시 · 'sample' = 미리보기): '예시 데이터 · 실시간 아님' 표시, mock은 점선
 * @param {{ data?: { source, items, fetchedAt?, stale?, ageSec?, nowMs? }, weather?: { source, wet, pty, ptyText, rn1Mm, t1h, reh, baseTime, stale?, ageSec? }, congestion?: string }} p
 */
export default function IncidentStrip({ data, weather, congestion }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const items = data?.items || [];
  const w = weather && ['kma', ...EXAMPLE].includes(weather.source) && weather.wet ? weather : null; // 비 · 눈일 때만
  if (!items.length && !w) return null;

  const nowMs = data?.nowMs ?? weather?.nowMs ?? Date.now();
  const incEx = items.length > 0 && EXAMPLE.includes(data?.source);
  const wxEx = Boolean(w) && EXAMPLE.includes(w.source);
  const example = incEx || wxEx;
  const mock = data?.source === 'mock' || weather?.source === 'mock'; // 버스까지 예시 데이터(점선)
  const congested = ['normal', 'heavy'].includes(congestion);
  const active = items.find((x) => x.status === 'active');
  const caution = !mock && congested && (Boolean(w) || Boolean(active));
  const top = items[0];
  const K = w ? WX : KIND[top.kind] || KIND.work;
  const kind = w ? wxKind(w) : '';
  const obs = w ? obsTime(w) : '';

  let title, sub;
  if (open) {
    title = w && items.length ? '경로 주변 날씨 · 돌발정보' : w ? '경로 주변 날씨' : `경로 주변 돌발정보 ${items.length}건`;
    sub = caution ? '정체 원인일 수 있어요' : '지연 원인을 확정하는 건 아니에요';
  } else if (caution) {
    title = `정체 원인일 수 있어요 · ${[w && kind, (active || (!w && top))?.label].filter(Boolean).join(' · ')}`;
    sub = w ? `${weatherText(w)}${obs ? `(${obs} 관측)` : ''}${top ? ` · ${top.title}` : ''}` : `${top.title} · ${whereText(top)}`;
  } else if (mock) {
    title = `${[w && `${kind} 오는 중`, top && headline(top)].filter(Boolean).join(' · ')} (예시)`;
  } else if (w) {
    title = wxHeadline(w);
    sub = [obs && `${obs} 관측`, !congested && '지금은 원활해요', top && headline(top)].filter(Boolean).join(' · ');
  } else {
    title = `${headline(top)}${example ? ' (예시)' : ''}`;
    sub = !congested ? `${statusText(top, nowMs)} · 지금은 원활해요` : `${top.title} · ${whereText(top)}`;
  }
  const tone = mock ? 'border-dashed border-ink-muted/70 bg-surface' : caution ? 'border-caution-dot/50 bg-caution-soft' : 'border-line bg-panel shadow-card';
  const updated = data?.fetchedAt ? fmtKst(Date.parse(data.fetchedAt), nowMs) : '';
  const ago = (sec) => Math.max(1, Math.round((sec || 0) / 60));

  // 출처 줄: 예시가 섞이면 '예시 데이터 · 실시간 아님' + 어느 쪽이 예시인지
  const realParts = [
    w && !wxEx && `기상청 초단기실황 ${obs} 관측${w.stale ? ` · 연결이 끊겨 ${ago(w.ageSec)}분 전 정보` : ''}`,
    items.length > 0 && !incEx && `서울시 돌발정보${updated ? ` ${updated} 갱신` : ''}${data?.stale ? ` · 연결이 끊겨 ${ago(data.ageSec)}분 전 정보` : ''}`,
  ].filter(Boolean);
  const exampleWhat = incEx && (wxEx || !w) ? '실제 정보가 아니에요' : incEx ? '돌발정보는 예시예요' : '날씨는 예시예요';

  return (
    <section aria-label="경로 주변 날씨 · 돌발정보" data-testid="incident-strip" data-tone={mock ? 'mock' : caution ? 'caution' : 'info'}
      data-source={data?.source ?? ''} data-weather={w ? (w.pty || 1) : ''} className={`min-w-0 rounded-2xl border px-3.5 py-2 ${tone}`}>
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)} className="flex w-full min-w-0 items-center gap-2.5 text-left">
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${mock ? 'bg-line text-ink-muted' : caution ? 'bg-caution-dot/30 text-caution' : K.dot}`}><K.Icon /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold leading-snug">{title}</span>
          {mock && !open
            ? <span className="mt-0.5 block"><SampleTag>예시 데이터 · 실시간 아님</SampleTag></span>
            : (
              <span className={`block truncate text-[13px] leading-snug ${caution ? 'text-caution' : 'text-ink-muted'}`}>
                {example && !open && <span className="mr-1 inline-block rounded border border-dashed border-ink-muted px-1 text-[11px] font-semibold leading-4 text-ink-muted">예시</span>}
                {sub}
              </span>
            )}
        </span>
        <span className="flex shrink-0 items-center">
          <span className="flex items-center text-[13px] font-semibold text-primary">
            {open ? '접기' : !w && items.length > 1 ? `${items.length}건` : '보기'}
            <IconChevron className={`h-4 w-4 transition-transform ${open ? '-rotate-90' : ''}`} />
          </span>
        </span>
      </button>

      {open && (
        <div id={listId}>
          <ul className="mt-2.5 grid gap-2">
            {w && (
              <li data-testid="weather-item" className="rounded-xl border border-[#BFDDF0] bg-panel px-3 py-2">
                <p className="flex min-w-0 items-center gap-1.5">
                  <span className={`inline-flex h-[22px] shrink-0 items-center rounded-md border px-1.5 text-xs font-bold ${WX.chip}`}>날씨</span>
                  <span className="min-w-0 truncate text-[14px] font-bold">{weatherText(w)}{wxEx ? ' (예시)' : ''}</span>
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                  <b className="font-semibold text-ink">국민대 주변</b>{obs ? ` · ${obs} 관측` : ''}{w.stale ? ` · ${ago(w.ageSec)}분 전 정보` : ''}
                  <br />{[w.t1h != null && `기온 ${w.t1h}℃`, w.reh != null && `습도 ${w.reh}%`, '기상청 초단기실황'].filter(Boolean).join(' · ')}
                </p>
              </li>
            )}
            {items.slice(0, 3).map((it) => {
              const k = KIND[it.kind] || KIND.work;
              const when = it.status === 'soon' ? `${periodText(it, nowMs)} · 예정` : periodText(it, nowMs);
              return (
                <li key={it.id || it.title} data-testid="incident-item" className="rounded-xl border border-line bg-panel px-3 py-2">
                  <p className="flex min-w-0 items-center gap-1.5">
                    <span className={`inline-flex h-[22px] shrink-0 items-center rounded-md border px-1.5 text-xs font-bold ${k.chip}`}>{it.label}</span>
                    <span className="min-w-0 truncate text-[14px] font-bold">{it.title}</span>
                  </p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                    <b className="font-semibold text-ink">{whereText(it)}</b>{it.nearStop ? ` · ${it.nearStop} 근처` : ''}
                    <br />{[when, it.control].filter(Boolean).join(' · ')}
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] leading-snug text-ink-muted">
            {example && <><SampleTag>예시 데이터 · 실시간 아님</SampleTag><span>{exampleWhat}</span></>}
            {realParts.length > 0 && <span>{realParts.join(' · ')} · 정체의 원인이라고 확정하는 건 아니에요</span>}
          </p>
        </div>
      )}
    </section>
  );
}
