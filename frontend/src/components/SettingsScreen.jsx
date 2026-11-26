import { useCallback, useId, useState } from 'react';
import { Button, Chip, IconChevron, IconCube, IconExternal, IconMail, IconStop, IconTrash, SourceTag } from './ui.jsx';
import PushPanel from './PushPanel.jsx';
import KCardSettings from './KCardSettings.jsx';
import TransitSettings from './TransitSettings.jsx';
import DeleteDataDialog from './DeleteDataDialog.jsx';

// v2.2.5 문의(데이터 정책 2026-11-23 확정): 오류 · 제안은 공개 게시판(GitHub Issues), 개인 기록에 관한 요청은 이메일
export const ISSUES_URL = 'https://github.com/405woon-bot/ku-bus-ai/issues';
export const CONTACT_EMAIL = '405woon@gmail.com';

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

/** 설정 · 돌발정보 줄: 서버 상태(health.incidents)와 마지막 응답(live.incidents — 환승 경로면 /api/transit/live)으로 */
function incidentStatus(mode, inc, h, transitOn = false) {
  if (mode !== 'api') return ['muted', '미리보기 · 예시', '서버 없는 미리보기라 예시 돌발정보를 보여 줘요(실시간 아님).'];
  if (inc?.source === 'mock') {
    return ['muted', '예시 데이터', `버스 정보가 예시 데이터라 돌발정보도 예시로 보여 줘요(실시간 아님).${h && !h.keyConfigured ? ' 서버에 SEOUL_ACCIDENT_API_KEY도 없어요.' : ''}`];
  }
  if (h && !h.keyConfigured) return ['muted', '꺼짐', '서버에 SEOUL_ACCIDENT_API_KEY가 없어 꺼져 있어요.'];
  if (inc?.source === 'error') return ['danger', '오류', inc.message || '서울시 돌발정보를 받지 못했어요. 잠시 뒤 다시 시도해요.'];
  if (inc?.source === 'loading') return ['muted', '불러오는 중', '서울시 돌발정보를 처음 받는 중이에요.'];
  const min = Math.round((h?.cacheSec || 300) / 60);
  if (inc?.source === 'seoul') {
    return inc.stale ? ['warn', `직전 값 · ${inc.items.length}건`, `서울시 연결이 잠시 끊겨 ${Math.max(1, Math.round((inc.ageSec || 0) / 60))}분 전 정보를 보여 줘요.`]
      : ['ok', `연결됨 · ${inc.items.length}건`, transitOn ? `서울시 돌발정보를 ${min}분마다 받아 환승 경로의 버스 구간 주변(300m)과 국민대 근처(1km)만 보여 줘요.` : `서울시 돌발정보를 ${min}분마다 받아 경로 주변(300m)과 국민대 근처(1km)만 보여 줘요.`];
  }
  if (h?.lastError && !h?.lastOkAt) return ['danger', '오류', h.lastError.message];
  return ['muted', '대기', transitOn ? '홈에서 환승 경로 실시간을 받으면 경로 주변 돌발정보를 확인해요.' : '탑승 정류장을 고르면 경로 주변 돌발정보를 확인해요.'];
}

/** 설정 · 날씨(기상청) 줄: 서버 상태(health.weather)와 마지막 응답(live.weather)으로 */
function weatherStatus(mode, wx, h, transitOn = false) {
  const obs = wx?.baseTime && /^\d{4}$/.test(wx.baseTime) ? `${wx.baseTime.slice(0, 2)}:${wx.baseTime.slice(2)}` : '';
  if (mode !== 'api') return ['muted', '미리보기 · 예시', '서버 없는 미리보기라 예시 날씨를 보여 줘요(실시간 아님). 비 · 눈일 때만 홈에 나와요.'];
  if (wx?.source === 'mock') {
    return ['muted', '예시 데이터', `버스 정보가 예시 데이터라 날씨도 예시로 보여 줘요(실시간 아님).${h && !h.keyConfigured ? ' 서버에 KMA_API_KEY도 없어요.' : ''}`];
  }
  if (h && !h.keyConfigured) return ['muted', '꺼짐', '서버에 KMA_API_KEY가 없어 꺼져 있어요.'];
  if (wx?.source === 'error') return ['danger', '오류', `${wx.message || '기상청 날씨를 받지 못했어요.'} 날씨만 빼고 보여 줘요.`];
  if (wx?.source === 'loading') return ['muted', '불러오는 중', '기상청 날씨를 처음 받는 중이에요.'];
  const grid = h?.grid ? `(${h.grid.nx} · ${h.grid.ny})` : '';
  if (wx?.source === 'kma') {
    return wx.stale ? ['warn', `직전 값 · ${obs} 관측`, `기상청 연결이 잠시 끊겨 ${Math.max(1, Math.round((wx.ageSec || 0) / 60))}분 전 정보를 보여 줘요.`]
      : ['ok', `연결됨 · ${obs} 관측`, `국민대 격자${grid} 실황을 ${Math.round((h?.cacheSec || 600) / 60)}분마다 받아요. 비 · 눈일 때만 홈에 보여 줘요.`];
  }
  if (h?.lastError && !h?.lastOkAt) return ['danger', '오류', h.lastError.message];
  return ['muted', '대기', transitOn ? '홈에서 환승 경로 실시간을 받으면 국민대 날씨를 확인해요.' : '탑승 정류장을 고르면 국민대 날씨를 확인해요.'];
}

/** 설정 · AI 설명(Gemini) 줄: 서버 상태(health.explain)로. 키 · 모델은 서버 환경변수(GEMINI_API_KEY · GEMINI_MODEL) */
const kstHHMM = (iso) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
function explainStatus(mode, live, h) {
  if (mode !== 'api') return ['muted', '미리보기 · 예시', '서버 없는 미리보기라 예시 문장을 보여 줘요(실제 AI 응답 아님). 버스가 막힐 때만 홈에 나와요.'];
  if (live?.source === 'mock') {
    return ['muted', '예시 데이터', `버스 정보가 예시 데이터라 AI를 부르지 않고 기본 안내로 보여 줘요(실시간 아님).${h && !h.keyConfigured ? ' 서버에 GEMINI_API_KEY도 없어요.' : ''}`];
  }
  if (!h) return ['muted', '대기', '버스가 막힐 때 홈에 \'왜 늦나요?\' 한 줄을 보여 줘요.'];
  if (!h.keyConfigured) return ['muted', '꺼짐', '서버에 GEMINI_API_KEY가 없어 AI 없이 기본 안내만 보여 줘요.'];
  const model = h.model || 'Gemini', err = h.lastError;
  if (h.cooldownUntil && err) {
    if (err.kind === 'quota') return ['warn', '기본 안내 중', `Gemini 호출 한도를 넘어 ${kstHHMM(h.cooldownUntil)}까지 기본 안내로 보여 줘요.`];
    if (err.kind === 'auth' || err.kind === 'bad-request') return ['danger', '오류', `Gemini 키를 확인해 주세요(${err.message}). 그동안 기본 안내로 보여 줘요.`];
    if (err.kind === 'model') return ['danger', '오류', `모델 ${model}을(를) 쓸 수 없어요. Render 환경변수 GEMINI_MODEL을 확인해 주세요. 그동안 기본 안내로 보여 줘요.`];
    return ['warn', '기본 안내 중', `${err.message} — ${kstHHMM(h.cooldownUntil)}까지 기본 안내로 보여 줘요.`];
  }
  if (h.maxPerDay && h.callsToday >= h.maxPerDay) return ['warn', '기본 안내 중', `오늘 호출 상한(${h.maxPerDay}회)에 닿아 자정까지 기본 안내로 보여 줘요.`];
  const min = Math.round((h.cacheSec || 300) / 60);
  const aiSeen = (live?.trips || []).some((t) => t.explain?.source === 'gemini'); // 상태(1분마다)보다 홈 응답(20초마다)이 먼저 알 때
  return h.lastOkAt || aiSeen
    ? ['ok', `연결됨 · ${model}`, `막힐 때만, 같은 상황이면 ${min}분 동안 다시 묻지 않아요. 실패하면 기본 안내로 바로 바꿔요.${h.callsToday ? ` 오늘 ${h.callsToday}번 물어봤어요.` : ''}`]
    : ['ok', `준비됨 · ${model}`, '아직 AI에 물어본 적이 없어요. 버스가 막히면 물어봐요(주소 끝에 /api/explain/test를 열면 바로 시험).'];
}

/** 설정 · 환승 경로(ODsay) 줄: 서버 상태(health.odsay) — 키는 서버 환경변수 ODSAY_API_KEY */
function odsayStatus(mode, h) {
  if (mode !== 'api') return ['muted', '미리보기 · 예시', '서버 없는 미리보기라 홍대입구역 예시 경로만 보여 줘요(실제 ODsay 응답 아님).'];
  if (!h) return ['muted', '확인 중', '서버 상태를 불러오는 중이에요.'];
  if (!h.keyConfigured) return ['muted', '꺼짐', '서버에 ODSAY_API_KEY가 없어 출발지 환승 경로를 찾을 수 없어요(근처 국민대행 정류장이나 고급의 정류장 직행으로 안내).'];
  if (h.lastError?.kind === 'auth') return ['danger', '인증 오류', `ODsay가 키를 받지 않았어요. ODsay에 등록한 서비스 URI(${h.referer || 'https://ku-bus-ai.onrender.com'})와 Render의 ODSAY_API_KEY를 확인해 주세요.`];
  if (h.cap && h.callsToday >= h.cap) return ['warn', `오늘 ${h.cap}회 다 씀`, '새 출발지 검색은 자정에 다시 열려요. 저장한 경로 · 찾아 둔 출발지(90일까지)는 그대로 써요.'];
  const w = h.warm?.enabled ? ` · 주요 환승역 ${h.warm.list}곳${h.warm.ready != null ? ` 중 ${h.warm.ready}곳` : ''}은 ${String(h.warm.hours || '21:00').slice(0, 5)}부터 그날 남은 한도로 미리 찾아 둬요(${h.warm.reserve}회는 남김)` : '';
  return ['ok', `준비됨 · 오늘 ${h.callsToday || 0}/${h.cap || 25}회`, `새 경로 검색은 하루 ${h.cap || 25}번까지, 같은 출발지(같은 이름이거나 300m 안)는 30일 동안 저장한 결과를 써요. 찾아 둔 출발지 ${h.cachedOrigins ?? 0}곳${w}.`];
}

/** 설정 · 실시간 지하철 줄: 서버 상태(health.seoulSubway) — 키는 서버 환경변수 SEOUL_SUBWAY_KEY */
function subwayStatus(mode, h) {
  if (mode !== 'api') return ['muted', '미리보기 · 예시', '서버 없는 미리보기라 예시 열차 도착을 보여 줘요(실시간 아님).'];
  if (!h) return ['muted', '확인 중', '서버 상태를 불러오는 중이에요.'];
  if (!h.keyConfigured) return ['muted', '꺼짐', '서버에 SEOUL_SUBWAY_KEY가 없어 지하철은 배차간격으로 예상해요.'];
  if (h.quotaToday || (h.cap && h.callsToday >= h.cap)) return ['warn', '오늘 한도 다 씀', '서울시 실시간 지하철 하루 한도에 닿아 자정까지 배차간격으로 예상해요.'];
  if (h.lastError && !h.lastOkAt) return ['danger', '오류', `${h.lastError.message} — 그동안 배차간격으로 예상해요.`];
  // v2.6.0 환승 지하철 몫(h.mid.cap, 0이면 끔): 켜져 있으면 설명에 함께 · 오늘 몫을 다 쓴 날은 그 안내(상태 칩은 그대로)
  const midCap = h.mid?.cap || 0;
  if (h.lastOkAt && midCap && h.mid?.capReached) return ['ok', `연결됨 · 오늘 ${h.callsToday}회`, `오늘 환승 지하철 몫(${midCap}회)을 다 써 자정까지 환승 지하철은 배차간격으로 예상해요. 첫 지하철은 그대로 받아요.`];
  return h.lastOkAt ? ['ok', `연결됨 · 오늘 ${h.callsToday}회`, midCap
    ? `환승 경로의 첫 지하철은 출발 30분 전부터, 환승 지하철은 출발했어요! 뒤 탈 때 15분 전부터 받아요(하루 ${h.cap || 900}회 상한 · 환승 지하철은 그중 ${midCap}회까지).`
    : '환승 경로의 첫 지하철 도착을 출발 30분 전부터 30초마다 받아요(하루 900회 상한).']
    : ['ok', '준비됨', '환승 경로 모드에서 출발 30분 전부터 첫 지하철 도착을 받아요. 받기 전에는 배차간격으로 예상해요.'];
}

/** v2.5.0 설정 · 경기도 버스 줄(승인한 미리보기 그대로): 서버 상태(health.gyeonggiBus) — 키는 서버 환경변수 GYEONGGI_BUS_API_KEY. 미리보기 빌드에는 이 줄이 없음 */
function gyeonggiStatus(h) {
  if (!h) return ['muted', '확인 중', '서버 상태를 불러오는 중이에요.'];
  if (!h.keyConfigured) return ['muted', '꺼짐', '서버에 GYEONGGI_BUS_API_KEY가 없어 경기도 정류장의 첫 버스는 배차간격으로 예상해요.'];
  if (h.quotaToday || h.capReached) return ['warn', '오늘 한도 다 씀', '경기도 버스 하루 한도에 닿아 자정까지 배차간격으로 예상해요.'];
  if (h.lastError && !h.lastOkAt) return ['danger', '오류', `${h.lastError.message} — 그동안 배차간격으로 예상해요.`];
  const total = Object.values(h.callsToday || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  // v2.7.0 환승 버스(경기도 정류장) 몫(h.mid.cap, 0이면 끔): 켜져 있으면 설명에 함께 · 오늘 몫을 다 쓴 날은 그 안내(상태 칩은 그대로)
  const midCap = h.mid?.cap || 0;
  if (h.lastOkAt && midCap && h.mid?.capReached) return ['ok', `연결됨 · 오늘 ${total}회`, `오늘 환승 버스 몫(${midCap}회)을 다 써 자정까지 경기도 정류장의 환승 버스는 배차간격으로 예상해요. 첫 버스는 그대로 받아요.`];
  return h.lastOkAt ? ['ok', `연결됨 · 오늘 ${total}회`, midCap
    ? `출발지 첫 버스가 경기도 정류장이면 출발 30분 전부터, 출발했어요! 뒤 환승 버스가 경기도 정류장이면 탈 때 15분 전부터 경기도 도착 정보를 받아요(하루 ${h.cap || 900}회 상한 · 환승 버스는 그중 ${midCap}회까지).`
    : `출발지 첫 버스가 경기도 정류장이면 출발 30분 전부터 경기도 도착 정보를 받아요(하루 ${h.cap || 900}회 상한).`]
    : ['ok', '준비됨', '출발지 첫 버스가 경기도 정류장이면 출발 30분 전부터 경기도 도착 정보를 받아요. 받기 전에는 배차간격으로 예상해요.'];
}

/**
 * v2.7.0 환승 경로일 때 '실시간 데이터' 설명 — 서울시 정류장 환승 버스 몫(health.live.mid · 0이면 끔) · 보호선(서울시 정류장 조회 800회)
 *   미리보기(서버 없음)는 기본값(100회)으로 보여 줌
 */
function transitSrcDesc(mid) {
  const base = '출발지 환승 경로로 안내 중이라 홈에서 첫 탑승 · 국민대행 버스 실시간을 30초마다 받아요(지하철은 출발 30분 전부터).';
  if (mid?.guardReached) return `오늘 서울시 정류장 조회가 ${mid.guardAt || 800}회를 넘어 자정까지 환승 버스는 배차간격으로 예상해요. 첫 버스 · 국민대행 버스는 그대로 받아요.`;
  if (mid?.cap && mid.capReached) return `오늘 환승 버스(서울시 정류장) 몫 ${mid.cap}회를 다 써 자정까지 그 환승 버스는 배차간격으로 예상해요. 첫 버스 · 국민대행 버스는 그대로 받아요.`;
  const cap = mid ? Number(mid.cap) || 0 : 100;
  return cap > 0 ? `${base} 출발했어요! 뒤에는 다음 탈 환승 지하철 · 버스를 탈 때 15분 전부터 받아요(서울시 정류장 환승 버스는 하루 ${cap}회까지).` : base;
}

/** 설정 · 서버 저장소 줄: 외부 DB(Upstash)면 서버가 잠들거나 다시 배포돼도 시간표 · 정류장 · 알림 구독이 그대로 */
function storageStatus(mode, h) {
  if (mode !== 'api') return ['muted', '미리보기 · 서버 없음', '미리보기는 이 기기에만 저장해요.'];
  if (!h) return ['muted', '확인 중', '서버 상태를 불러오는 중이에요.'];
  if (h.kind === 'upstash') {
    if (h.lastError) return ['danger', '외부 DB · 오류', `${h.lastError.message}${h.loaded ? ' — 잠시 뒤 다시 저장해요.' : ' — 다시 읽는 중이에요. 그동안은 임시로 저장해요.'}`];
    return h.loaded ? ['ok', '외부 DB · 연결됨', '시간표 · 정류장 · 알림 구독을 외부 DB(Upstash Redis)에 저장해요. 서버가 잠들거나 다시 배포돼도 그대로예요.']
      : ['muted', '외부 DB · 읽는 중', '외부 DB에서 저장된 내용을 읽는 중이에요.'];
  }
  return ['warn', '임시 파일 · 재시작하면 지워짐', 'Render에 UPSTASH_REDIS_REST_URL · UPSTASH_REDIS_REST_TOKEN을 넣으면 외부 DB에 저장해요. 지금은 서버가 잠들면 알림 구독이 지워질 수 있어요.'];
}

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

/** 실시간 데이터 출처 · 돌발정보 · 날씨 · AI 설명 · 서버 동기화 · 서버 저장소 상태 */
function ServerGroup({ mode, live: directLive, transitLive = null, health, sync, transitOn = false }) {
  // v2.1 환승 경로면 /api/transit/live의 돌발정보 · 날씨 · 마지막 국민대행 버스(설명)로 상태를 보여 줌
  const live = transitOn ? { source: transitLive?.sample ? 'sample' : 'seoul', incidents: transitLive?.incidents, weather: transitLive?.weather, trips: transitLive?.final?.trips || [] } : directLive;
  const src = live?.source ? { source: live.source, reason: live.reason, stale: Boolean(live.stale) || live.status === 'stale' }
    : health?.provider ? { source: health.provider, reason: health.reason } : null;
  const srcDesc = transitOn ? transitSrcDesc(health?.live?.mid)
    : !src ? '탑승 정류장을 고르면 표시돼요'
    : src.source === 'mock' ? '실시간을 받지 못해 예시 데이터로 계산 중이에요. 연결되면 자동으로 바뀌어요.'
      : src.stale ? '서울시 연결이 잠시 끊겨 직전 값을 쓰는 중이에요.' : '서울시 버스 API에서 20초마다 받아요.';
  const [syncLevel, syncText] = mode === 'api' ? (SYNC[sync] || SYNC.loading) : ['muted', '미리보기 · 서버 없음'];
  const [stLevel, stText, stDesc] = storageStatus(mode, health?.storage);
  const [incLevel, incText, incDesc] = incidentStatus(mode, live?.incidents, health?.incidents, transitOn);
  const [wxLevel, wxText, wxDesc] = weatherStatus(mode, live?.weather, health?.weather, transitOn);
  const [aiLevel, aiText, aiDesc] = explainStatus(mode, live, health?.explain);
  const [odLevel, odText, odDesc] = odsayStatus(mode, health?.odsay);
  const [sbLevel, sbText, sbDesc] = subwayStatus(mode, health?.seoulSubway);
  const [ggLevel, ggText, ggDesc] = gyeonggiStatus(health?.gyeonggiBus);
  return (
    <Group title="데이터 · 서버 연결">
      <Item label="실시간 데이터" desc={srcDesc}>
        {transitOn ? <Chip level="info">환승 경로</Chip> : src ? <SourceTag {...src} /> : <Chip>정류장 미선택</Chip>}
      </Item>
      <Item label="돌발정보" desc={incDesc}>
        <span data-testid="incident-status"><Chip level={incLevel}>{incText}</Chip></span>
      </Item>
      <Item label="날씨(기상청)" desc={wxDesc}>
        <span data-testid="weather-status"><Chip level={wxLevel}>{wxText}</Chip></span>
      </Item>
      <Item label="AI 설명(Gemini)" desc={aiDesc}>
        <span data-testid="explain-status"><Chip level={aiLevel}>{aiText}</Chip></span>
      </Item>
      <Item label="환승 경로(ODsay)" desc={odDesc}>
        <span data-testid="odsay-status"><Chip level={odLevel}>{odText}</Chip></span>
      </Item>
      <Item label="실시간 지하철" desc={sbDesc}>
        <span data-testid="subway-status"><Chip level={sbLevel}>{sbText}</Chip></span>
      </Item>
      {mode === 'api' && (
        <Item label="경기도 버스" desc={ggDesc}>
          <span data-testid="gyeonggi-status"><Chip level={ggLevel}>{ggText}</Chip></span>
        </Item>
      )}
      <Item label="서버 동기화" desc="시간표·정류장·설정을 서버에 저장해요. 서버가 이 값으로 알림을 계산해요.">
        <Chip level={syncLevel}>{syncText}</Chip>
      </Item>
      <Item label="서버 저장소" desc={stDesc}>
        <span data-testid="storage-status"><Chip level={stLevel}>{stText}</Chip></span>
      </Item>
    </Group>
  );
}

/** v2.2.5 내 데이터: 무엇을 저장하는지 · 90일 자동 삭제 · K•CARD+는 이 기기만 · 문의 · [내 데이터 모두 삭제](승인한 미리보기 그대로) */
function MyDataGroup({ onDelete }) {
  const link = 'inline-flex items-center justify-center whitespace-nowrap rounded-[10px] border font-semibold transition-colors h-8 px-2.5 text-[13px] gap-1.5 bg-panel text-ink border-line hover:border-primary-line hover:text-primary';
  return (
    <section aria-label="내 데이터" className="grid grid-cols-1 gap-2" data-testid="mydata">
      <h2 className="px-1 text-[13px] font-bold text-ink-muted">내 데이터</h2>
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel shadow-card">
        <Item label="서버에 저장하는 것" desc="시간표 · 탑승 정류장 · 출발지(GPS는 약 100m 칸) · 설정 · 알림 구독 · 알림/도착 기록. 출발 알림 계산에만 써요." />
        <Item label="보관 기간" desc="앱을 쓰거나 출발 알림을 받은 지 90일이 지나면 서버 기록은 자동으로 지워져요."><Chip level="info">90일</Chip></Item>
        <Item label="K•CARD+ 캡처" desc="이 기기에만 있어요. 서버로 보내지 않아요."><Chip>이 기기만</Chip></Item>
        <div className="grid gap-2 px-4 py-3.5">
          <div>
            <p className="text-[15px] font-semibold">문의</p>
            <p className="text-xs text-ink-muted">오류 · 제안은 GitHub Issues에, 내 기록에 관한 요청은 이메일로 알려 주세요.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer" className={link} data-testid="contact-issues"><IconExternal className="h-4 w-4" />GitHub Issues</a>
            <a href={`mailto:${CONTACT_EMAIL}`} className={link} data-testid="contact-mail"><IconMail className="h-4 w-4" />{CONTACT_EMAIL}</a>
          </div>
        </div>
        <div className="grid gap-2 px-4 py-3.5">
          <p className="text-xs leading-relaxed text-ink-muted">서버 기록과 이 기기의 저장값을 지금 바로 지워요. 되돌릴 수 없어요.</p>
          <Button variant="danger" className="w-full" onClick={onDelete} data-testid="delete-all"><IconTrash className="h-5 w-5" />내 데이터 모두 삭제</Button>
        </div>
      </div>
    </section>
  );
}

export default function SettingsScreen({ mode, state, dispatch, onPickStop, perm, onRequestPerm, onTestAlarm, info, push, onOpenGuide, sync, live, transitLive = null, health, kcard, onViewCard, onResetPersonal, highlightKCard, onResetAll, now, todayClass, nextClass, walkTable, highlightTransit, autoOrigin = null, onOriginDone, onDirectMode }) {
  const { prefs } = state;
  const hasRoute = Boolean(state.transit?.route?.legs?.length);
  const transitOn = state.transit?.mode === 'transit' && hasRoute;
  const setPrefs = (patch) => dispatch({ type: 'setPrefs', patch });
  const [confirmReset, setConfirmReset] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const closeDelete = useCallback(() => setDeleteOpen(false), []);
  // v2.1 정류장 직행은 '고급'(접힘) — 경로 없이 정류장으로만 안내 중이면 처음부터 펼쳐 둠
  const [advOpen, setAdvOpen] = useState(!transitOn && Boolean(state.stop));
  return (
    <div className="mx-auto grid w-full max-w-[560px] grid-cols-1 gap-6">
      <h1 className="px-1 text-[22px] font-bold">설정</h1>

      {now && state.transit && (
        <TransitSettings mode={mode} state={state} dispatch={dispatch} now={now} todayClass={todayClass} nextClass={nextClass} walkTable={walkTable || {}} highlight={highlightTransit}
          autoOrigin={autoOrigin} onDone={onOriginDone} />
      )}

      <Group title="출발 시각 계산" note={transitOn ? '출발지 → 첫 역 · 정류장 도보는 경로(ODsay)에서 가져와요.' : null}>
        <Item label="수업 전 도착 여유"><MinuteChips label="수업 시작 전 여유" value={prefs.marginMin} options={[0, 5, 10]} onChange={(m) => setPrefs({ marginMin: m })} /></Item>
      </Group>

      <section aria-label="고급 · 정류장 직행" className="grid grid-cols-1 gap-2" data-testid="advanced" data-open={advOpen ? 'true' : 'false'}>
        <h2 className="px-1 text-[13px] font-bold text-ink-muted">{advOpen ? '고급 · 정류장 직행' : '고급'}</h2>
        {!advOpen ? (
          <button type="button" onClick={() => setAdvOpen(true)} aria-expanded={false} data-testid="advanced-open"
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-panel px-4 py-3.5 text-left shadow-card hover:bg-surface">
            <span className="min-w-0"><span className="block text-[15px] font-semibold">정류장 직행으로 안내</span>
              <span className="block text-xs text-ink-muted">국민대행 버스를 한 번만 탄다면 정류장만 골라도 돼요{state.stop ? ` · 지금 정류장: ${state.stop.name}` : ''}</span></span>
            <span className="flex shrink-0 items-center text-[13px] font-semibold text-primary">펼치기<IconChevron className="h-4 w-4" /></span>
          </button>
        ) : (
          <>
            <div className="divide-y divide-line rounded-2xl border border-line bg-panel shadow-card">
              <button type="button" onClick={onPickStop} data-testid="stop-row" className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface">
                <IconStop className="h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold">탑승 정류장</span>
                  <span className="block truncate text-xs text-ink-muted">{state.stop?.name || '정류장을 골라 주세요'}</span></span>
                <span className="flex shrink-0 items-center text-[13px] font-semibold text-primary">{state.stop ? '바꾸기' : '고르기'}<IconChevron className="h-4 w-4" /></span>
              </button>
              <Item label="정류장까지 걸어서"><MinuteChips label="정류장까지 걷는 시간" value={prefs.walkToStopMin} options={[3, 5, 10, 15]} onChange={(m) => setPrefs({ walkToStopMin: m })} /></Item>
              {hasRoute ? (
                <Item label="정류장 직행으로 안내" desc={state.stop ? '켜면 환승 경로 대신 이 정류장의 국민대행 버스로 안내해요' : '정류장을 먼저 골라 주세요'}>
                  <span data-testid="direct-switch"><Switch label="정류장 직행으로 안내" checked={state.transit?.mode === 'direct'} onChange={(v) => { if (state.stop || !v) onDirectMode?.(v); }} /></span>
                </Item>
              ) : (
                <p className="px-4 py-3 text-xs leading-relaxed text-ink-muted">출발지 환승 경로를 고르기 전에는 이 정류장으로 직행 안내해요.</p>
              )}
            </div>
            <button type="button" onClick={() => setAdvOpen(false)} className="justify-self-start px-1 text-xs font-semibold text-ink-muted hover:text-ink">접기</button>
          </>
        )}
      </section>

      {kcard && <KCardSettings mode={mode} kcard={kcard} personal={state.personal} arrivals={state.arrivals} onView={onViewCard} onReset={onResetPersonal} highlight={highlightKCard} />}

      <Group title="알림">
        <Item label="출발 알림" desc="출발 시각 전, 출발이 앞당겨질 때, 지각 위험일 때"><Switch label="출발 알림" checked={prefs.notify} onChange={(v) => setPrefs({ notify: v })} /></Item>
        {prefs.notify && <Item label="출발 몇 분 전에"><MinuteChips label="출발 몇 분 전에 알릴지" value={prefs.notifyBeforeMin} options={[5, 10, 15]} onChange={(m) => setPrefs({ notifyBeforeMin: m })} /></Item>}
        <Item label="앱을 연 동안 알림" desc={`화면 위에 띄우는 알림 · ${PERM[perm] || perm}`}>
          <div className="flex gap-2">
            {perm === 'default' && <Button size="sm" variant="primary" onClick={onRequestPerm}>허용하기</Button>}
            <Button size="sm" onClick={onTestAlarm}>테스트</Button>
          </div>
        </Item>
      </Group>

      <PushPanel info={info} push={push} onOpenGuide={onOpenGuide} prefsNotify={prefs.notify} />

      <ServerGroup mode={mode} live={live} transitLive={transitLive} health={health} sync={sync} transitOn={transitOn} />

      <MyDataGroup onDelete={() => setDeleteOpen(true)} />
      {deleteOpen && <DeleteDataDialog mode={mode} onClose={closeDelete} />}

      <Group title="정보">
        {mode === 'sample' && (
          <a href="KU_Bus_3D_V4.html" target="_blank" rel="noopener" className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface">
            <IconCube className="h-5 w-5 shrink-0 text-primary" /><span className="flex-1 text-[15px] font-semibold">3D 캠퍼스 보기</span><IconExternal className="h-4 w-4 text-ink-muted" />
          </a>
        )}
        <div className="grid gap-1 px-4 py-3.5 text-xs leading-relaxed text-ink-muted">
          <p><span className="font-semibold text-ink">버스 도착·도로 정체</span> 서울특별시 정류소정보·노선정보 API(서버 경유, 20초마다 갱신). 받지 못하면 직전 값(3분 이내), 그다음 예시 데이터로 바꾸고 &lsquo;예시 데이터&rsquo;로 표시해요.{mode === 'sample' ? ' 이 미리보기는 같은 형식의 샘플 응답이에요.' : ''}</p>
          <p><span className="font-semibold text-ink">출발지 환승 경로</span> 대중교통 길찾기 ODsay LAB API(서버 경유, 하루 25회 · 같은 출발지 30일 저장) · 지하철 도착 서울 열린데이터광장 실시간 지하철 도착정보(출발 30분 전부터). 실시간을 못 받으면 배차간격으로 예상하고 &lsquo;예상&rsquo;으로 표시해요.</p>
          <p><span className="font-semibold text-ink">캠퍼스 도보 시간</span> OpenStreetMap 기반 추정 · 지도 데이터 © OpenStreetMap contributors (ODbL)</p>
        </div>
      </Group>

      <div className="flex flex-wrap items-center gap-2 px-1 pb-4">
        {confirmReset
          ? <><Button variant="danger" size="sm" onClick={() => { if (onResetAll) onResetAll(); else dispatch({ type: 'resetAll' }); setConfirmReset(false); }}>시간표·설정 모두 지우기</Button><Button size="sm" onClick={() => setConfirmReset(false)}>취소</Button></>
          : <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>처음 상태로 되돌리기</Button>}
      </div>
    </div>
  );
}
