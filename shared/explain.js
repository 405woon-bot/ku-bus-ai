// "왜 늦나요?" 한 줄 — 서버가 확인한 사실(JSON) 만들기 · 지연 분 계산 · 기본 안내 문장 · AI 문장 검사.
// 서버와 화면(미리보기)이 같이 씁니다. 숫자는 모두 여기(서버 쪽 계산)에서만 만들고, AI에는 숫자 대신 말로 묶은 사실만 넘깁니다.
import { CONGESTION, CONGESTION_KMH, DWELL_SEC } from './stopTrips.js';
import { wxKind } from './weather.js';

/** '원활' 기준 속도(앱의 정체 판단 기준과 같음, 시속 km) — 지연 분 = 실제 차내 시간 − 이 속도로 달렸을 때 */
export const FREE_FLOW_KMH = CONGESTION_KMH.smooth;
/** 근거가 하나도 없을 때 쓰는 고정 문장(AI를 부르지 않음) */
export const NO_CAUSE_TEXT = '특이 지연 원인은 확인되지 않았어요.';
const WEATHER_SOURCES = ['kma', 'mock', 'sample'];
const MAX_INCIDENTS = 3, TITLE_MAX = 30;

/**
 * 원활(시속 20km)로 달렸을 때보다 더 걸리는 시간(분, 반올림). 거리 · 차내 시간이 없으면(예시 데이터 등) null
 * 차내 시간 = Σ 구간거리 ÷ 구간속도 + 중간 정류장 × 20초 (shared/stopTrips.js와 같은 식)
 */
export function delayMinutes(trip) {
  if (!trip || !Number.isFinite(trip.distM) || trip.distM <= 0 || !Number.isFinite(trip.inVehicleMin)) return null;
  const freeMin = trip.distM / ((FREE_FLOW_KMH * 1000) / 60) + ((trip.intermediateStops || 0) * DWELL_SEC) / 60;
  return Math.max(0, Math.round(trip.inVehicleMin - freeMin));
}

/** 속도 → 말(숫자 대신 AI에 넘김) */
export function speedWord(kmh) {
  if (!Number.isFinite(kmh) || kmh <= 0) return null;
  if (kmh < 8) return '걷는 속도 수준으로 느림';
  if (kmh < 12) return '많이 느림';
  if (kmh < FREE_FLOW_KMH) return '조금 느림';
  return null;
}

/**
 * 가장 느린 곳: 정체 구간 표(shared/corridors.js)에 있으면 도로 이름('정릉로'),
 * 없으면 정류장 사이 구간('청덕초등학교입구~국민대학교앞 구간'). 시속 15km 미만 구간이 없으면 null
 */
export function slowPlace(trip) {
  const c = typeof trip?.cause === 'string' ? trip.cause.replace(/\s+/g, ' ').trim() : '';
  return c ? c.replace(/\s*→\s*/g, '~') : null;
}

/** 비 · 눈일 때만 강수 종류('비' · '눈' · '소나기' · '빗방울' …), 아니면 null */
function weatherWord(weather) {
  if (!weather || !WEATHER_SOURCES.includes(weather.source) || !weather.wet) return null;
  const k = wxKind(weather);
  if (!k || k === '알 수 없음' || k === '없음') return weather.rn1Mm > 0 ? '비' : null;
  return k;
}

const shortTitle = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= TITLE_MAX) return t;
  const cut = t.slice(0, TITLE_MAX), sp = cut.lastIndexOf(' ');
  return (sp >= 10 ? cut.slice(0, sp) : cut).trim();
};

/**
 * 한 노선의 '확인된 사실' — AI에 그대로 넘기는 JSON(키 순서 고정 → 같은 상황이면 같은 글자 → 캐시 키)
 * 돌발정보는 이 노선 경로 위 · 국민대 근처에서 '지금 진행 중'인 것만(예정된 것은 지금의 원인이 아니므로 뺌), 최대 3건
 * @param {object} trip  computeTrips 결과(congestion · cause · slowest · kmh · no)
 * @param {{ incidents?: { items?: Array }, weather?: object }} ctx  경로 주변 돌발정보 · 날씨(비 · 눈일 때만 씀)
 */
export function buildFacts(trip, { incidents, weather } = {}) {
  const place = slowPlace(trip);
  const inc = (incidents?.items || [])
    .filter((i) => i && i.status !== 'soon' && (i.where === 'campus' || (i.routes || []).includes(trip?.no)))
    .slice(0, MAX_INCIDENTS)
    .map((i) => ({ 종류: i.label, 이름: shortTitle(i.title), 위치: i.where === 'route' ? '경로 위' : '국민대 근처', 시점: '진행 중' }));
  return {
    '막힘 정도': CONGESTION[trip?.congestion]?.label ?? null,
    '가장 느린 도로': place,
    '느린 정도': speedWord(place ? (trip?.slowest?.kmh ?? trip?.kmh) : trip?.kmh),
    날씨: weatherWord(weather),
    '주변 돌발정보': inc,
  };
}

/** 근거(느린 도로 · 날씨 · 진행 중인 돌발정보)가 하나라도 있는지 — 없으면 AI를 부르지 않고 NO_CAUSE_TEXT */
export const hasEvidence = (f) => Boolean(f && (f['가장 느린 도로'] || f.날씨 || (f['주변 돌발정보'] || []).some((i) => i.시점 !== '예정')));

/** 지금 원인일 수 있는 것(날씨 + 진행 중인 돌발 종류). '집회 · 행사' → '집회·행사'처럼 붙여 씀 */
export function causeWords(f) {
  const kinds = [...new Set((f?.['주변 돌발정보'] || []).filter((i) => i.시점 !== '예정').map((i) => i.종류))];
  return [f?.날씨, ...kinds].filter(Boolean).map((w) => String(w).replace(/\s*·\s*/g, '·'));
}

// 받침 있으면 '이', 없으면 '가'(끝 글자가 숫자면 읽는 소리 기준: 0영 1일 3삼 6육 7칠 8팔 → 받침 있음)
const DIGIT_BATCHIM = '1101001110';
const hasBatchim = (word) => {
  const s = String(word), ch = s[s.length - 1] || '', c = ch.charCodeAt(0);
  if (/[0-9]/.test(ch)) return DIGIT_BATCHIM[Number(ch)] === '1';
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
};
/** 주격 조사 '이' · '가' */
export const josa = (word) => (hasBatchim(word) ? '이' : '가');
/** v2.2.6 '와' · '과'(예: '공사와 비') — 미리보기 예시 AI 문장에서 씀 */
export const josaWa = (word) => (hasBatchim(word) ? '과' : '와');

/**
 * 기본 안내 문장(AI를 쓸 수 없을 때 · 예시 데이터일 때). 숫자 없이 사실만.
 * 예: '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.' / '정릉로가 막혀요. 특이 원인은 확인되지 않았어요.'
 */
export function ruleText(f) {
  const place = f?.['가장 느린 도로'];
  const causes = causeWords(f);
  if (!place && !causes.length) return NO_CAUSE_TEXT;
  const first = place ? `${place}${josa(place)} 막혀요.` : '버스가 느리게 달리고 있어요.';
  return `${first} ${causes.length ? `${causes.join(' · ')} 영향일 수 있어요.` : '특이 원인은 확인되지 않았어요.'}`;
}

// ── AI 문장 검사: 사실에 없는 원인 · 숫자가 나오면 버림(지어내기 막기) ──
const has = (f, word) => JSON.stringify(f).includes(word);
const wxHas = (f, ...ws) => ws.some((w) => String(f?.날씨 || '').includes(w));
const kindHas = (f, w) => (f?.['주변 돌발정보'] || []).some((i) => i.시점 !== '예정' && String(i.종류).includes(w));
const CAUSE_CHECKS = [
  [/빗|우천|폭우|장마|소나기|(^|[^가-힣])비(가|까지|도|로|와|에|만|를|\s|·|,|\.|$)/, (f) => wxHas(f, '비', '빗방울', '소나기')],
  [/폭설|눈길|눈발|눈날림|(^|[^가-힣])눈(이|까지|도|으로|과|에|만|을|\s|·|,|\.|$)/, (f) => wxHas(f, '눈')],
  [/사고|추돌|충돌/, (f) => kindHas(f, '사고')],
  [/공사|작업/, (f) => kindHas(f, '공사')],
  [/집회|시위|행사|축제|마라톤|행진/, (f) => kindHas(f, '집회') || kindHas(f, '행사')],
];
const OTHER = /화재|고장|낙하물|재난|침수|통제|정전|신호|출근|퇴근|등교|러시|기상/g;
// 원인처럼 읽히는 낱말 — 이름에서 떼어 낸 낱말이 이것을 품으면 따로 빼 주지 않음('사고 다발 구간 공사'의 '사고'로 사고를 지어내지 못하게)
const CAUSE_ANY = /빗|우천|폭우|장마|소나기|비|눈|사고|추돌|충돌|공사|작업|집회|시위|행사|축제|마라톤|행진|화재|고장|낙하물|재난|침수|통제|정전|신호|출근|퇴근|등교|러시|기상/;

/** 사실 JSON 안의 글(도로 · 정류장 · 공사 이름 등 통째로)과 그 낱말(한글이 든 2글자 이상, 원인 낱말 제외) — 긴 것부터 */
function factTerms(f) {
  const vals = [];
  const walk = (v) => {
    if (typeof v === 'string') vals.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(f);
  const words = vals.flatMap((v) => v.split(/[\s~·,()/\-→]+/)).filter((w) => w.length >= 2 && /[가-힣]/.test(w) && !CAUSE_ANY.test(w));
  return [...new Set([...vals, ...words])].filter(Boolean).sort((a, b) => b.length - a.length);
}

// ── v2.2.6 원인을 결과에 잇는 말(단정하는 인과): 있으면 AI 문장을 버리고 기본 안내로 ──
//   쓰는 모양: 막히는 곳(사실)을 먼저 말하고, 원인일 수 있는 것은 따로 '…영향일 수 있어요'(예: '정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.')
//   버리는 말: 때문 · 탓 · 인해 · 덕분 · 여파 · '영향으로 · 영향을 받아' · 겹쳐 · ~니까 · ~므로 · '공사로 · 비로'처럼 원인 + 로 ·
//             '-아서 · -어서 · -해서 · -와서 · -라서 · -있어서 · -면서'처럼 '-서'로 잇는 말('에서' · '께서'는 장소 · 주어라 괜찮음).
//   '~수 있어요'로 끝나도 잇는 말이 있으면 버림(더 보수적). 사실에 든 이름(도로 · 구간 · 돌발 이름)은 검사에서 빼고, 날씨 · 돌발 종류 낱말은 남김
const CAUSAL_WORDS = [
  /때문|탓에|탓이|탓으로|인해|인한|인하여|덕분|여파/,
  /영향\s*(으로|을\s*받|을\s*주|을\s*줘|을\s*미)/,
  /겹쳐|겹친|겹치/,
  /니까|므로/,
  /(비|눈|소나기|빗방울|진눈깨비|우천|폭우|폭설|빗길|눈길|날씨|공사|작업|사고|추돌|충돌|집회|시위|행사|축제|마라톤|행진|정체)(으)?로(?=[\s,.!?…]|$)/,
];
const SEO_LINK = /([가-힣])서(?=[\s,.!?…]|$)/g;
/** 사실에 든 이름만 뺀 글(날씨 · 돌발 종류 낱말은 남김 — '공사로'처럼 잇는 말을 찾으려고) */
function namesOut(text, f) {
  const keep = new Set([f?.날씨, ...(f?.['주변 돌발정보'] || []).map((i) => i?.종류)].filter(Boolean).map(String));
  let p = String(text ?? '');
  for (const t of factTerms(f || {})) if (!keep.has(t)) p = p.split(t).join(' ');
  return p;
}
/** v2.2.6 AI 문장에 원인을 결과에 잇는 말이 있는지 */
export function hasCausalLink(text, f = {}) {
  const p = namesOut(text, f);
  if (CAUSAL_WORDS.some((re) => re.test(p))) return true;
  for (const m of p.matchAll(SEO_LINK)) if (m[1] !== '에' && m[1] !== '께') return true;
  return false;
}

/**
 * AI 응답 → 화면에 쓸 한 문장. 첫 줄만 · 따옴표 등 정리 · 한국어 · 짧게 · 숫자 없음 · 사실에 없는 원인 없음 · (v2.2.6) 원인을 단정해 잇지 않음
 * 사실에 든 이름(예: '정릉로9길')을 그대로 옮긴 부분은 숫자 · 원인 검사에서 뺍니다.
 * @returns {{ ok: true, text: string } | { ok: false, why: 'empty'|'format'|'long'|'number'|'ungrounded'|'causal' }}
 */
export function cleanAiText(raw, f) {
  let s = String(raw ?? '').replace(/[*_`#>"“”'‘’]/g, '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  s = s.replace(/^(출력|답변|문장)\s*[:：]\s*/, '').replace(/^왜 늦나요\s*\??\s*/, '').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, why: 'empty' };
  if (!/[가-힣]/.test(s)) return { ok: false, why: 'format' };
  let probe = s;
  for (const t of factTerms(f)) probe = probe.split(t).join(' ');
  if (s.length > 90 || probe.replace(/\s+/g, ' ').trim().length > 40) return { ok: false, why: 'long' };
  if (/[0-9０-９]/.test(probe)) return { ok: false, why: 'number' };
  for (const [re, ok] of CAUSE_CHECKS) if (re.test(probe) && !ok(f)) return { ok: false, why: 'ungrounded' };
  for (const m of probe.match(OTHER) || []) if (!has(f, m)) return { ok: false, why: 'ungrounded' };
  if (hasCausalLink(s, f)) return { ok: false, why: 'causal' };
  return { ok: true, text: /[.!?。]$/.test(s) ? s : `${s}.` };
}
