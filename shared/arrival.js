// '도착했어요!' — 개인 맞춤 출발 보정. LLM 없이 지수 가중 평균(EMA)으로 '내 걸음 · 환승 여유'(personalOffsetMin)를 고칩니다.
//
//   여유 = 수업 시작 − 도착(버튼을 누른 시각)        목표 = 수업 5분 전 도착(여유 5분)
//   늦음      (여유 < 5분)    오차 = 5 − 여유           보정 += 0.5 × 오차    한 번에 최대 +3분(빠르게 앞당김)
//   딱 좋음   (여유 5~10분)   그대로                     버스 배차 간격 때문에 생기는 여유는 배우지 않음
//   너무 일찍 (여유 > 10분)   오차 = 여유 − 10          보정 −= 0.25 × 오차   한 번에 최대 −2분(완만하게)
//   전체 범위 −5 ~ +15분 · 소수 첫째 자리까지 저장 · 계산과 화면에는 반올림한 정수(분)를 씀
//
//   보정값은 추천 계산(recommend)에서 '강의실 도착 예정'에 더해집니다 → +3분이면 '3분 더 걸린다'고 보고
//   그만큼 일찍 도착하는 버스와 출발 시각을 고릅니다(서버 출발 알림도 같은 값으로 계산).
import { toHHMM, toMin } from './time.js';

export const ARRIVAL = Object.freeze({
  targetSlackMin: 5,    // 목표: 수업 시작 5분 전 도착
  goodBandMin: 5,       // 목표보다 5분까지 더 일찍(수업 5~10분 전)은 '딱 좋음'
  windowBeforeMin: 30,  // 버튼: 수업 시작 30분 전부터
  windowAfterMin: 15,   //       수업 시작 15분 뒤까지
  alphaLate: 0.5,       // 늦었을 때 반영 비율
  alphaEarly: 0.25,     // 너무 일찍일 때 반영 비율
  maxUpMin: 3,          // 한 번에 최대 +3분
  maxDownMin: 2,        // 한 번에 최대 −2분
  minOffsetMin: -5,
  maxOffsetMin: 15,
  keep: 20,             // 최근 도착 기록 개수
});

const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 저장된 보정값을 안전하게(숫자가 아니면 0, 범위 밖이면 −5 ~ +15로 자름) */
export function personalOffset(v) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(round1(n), ARRIVAL.minOffsetMin, ARRIVAL.maxOffsetMin) : 0;
}
/** 계산 · 화면에 쓰는 보정(정수 분, 반올림 — 0.5는 일찍 출발 쪽으로) */
export const appliedOffset = (v) => Math.round(personalOffset(v)) || 0;

export const emptyPersonal = () => ({ offsetMin: 0, samples: 0, updatedAt: null });
export const arrivalKey = (dateKey, cls) => `${dateKey}:${cls.id}`;

/**
 * 오늘 첫 수업 기준 '도착했어요' 시간: 시작 30분 전 ~ 시작 15분 뒤(canRecord), 끝나기 전까지 수업 중(inClass)
 * phase: before(버튼 전) · window(버튼) · class(버튼 시간 지남, 수업 중) · after(수업 끝)
 */
export function arrivalWindow(cls, nowMin) {
  const startMin = toMin(cls?.start);
  if (!cls || !Number.isFinite(startMin)) return null;
  const e = toMin(cls.end), endMin = Number.isFinite(e) && e > startMin ? e : startMin + 75;
  const openMin = startMin - ARRIVAL.windowBeforeMin, closeMin = startMin + ARRIVAL.windowAfterMin;
  const phase = nowMin < openMin ? 'before' : nowMin <= closeMin ? 'window' : nowMin < endMin ? 'class' : 'after';
  return { startMin, endMin, openMin, closeMin, phase, canRecord: phase === 'window', inClass: phase === 'window' || phase === 'class' };
}

/** 여유(분, 수업 시작 − 도착)로 판정 — 화면에 보이는 '몇 분 전'(내림)과 맞춤 */
export function verdictOf(slackMin) {
  const s = Math.floor(slackMin + 1e-9);
  return s < 0 ? 'late' : s < ARRIVAL.targetSlackMin ? 'tight' : s <= ARRIVAL.targetSlackMin + ARRIVAL.goodBandMin ? 'good' : 'early';
}

/**
 * 도착 한 번으로 보정값 고치기(EMA)
 * @returns {{ offsetMin, prevOffsetMin, deltaMin, slackMin, errorMin, verdict, limited: 'max'|'min'|null }}
 *   errorMin: + 늦은 만큼(목표 기준) · − 너무 일찍 온 만큼(딱 좋음 범위 기준) · 0 딱 좋음
 */
export function learnOffset(prevOffsetMin, { arriveMin, startMin }) {
  const A = ARRIVAL, prev = personalOffset(prevOffsetMin), slack = startMin - arriveMin;
  let error = 0, step = 0;
  if (slack < A.targetSlackMin) {
    error = A.targetSlackMin - slack;
    step = Math.min(A.alphaLate * error, A.maxUpMin);
  } else if (slack > A.targetSlackMin + A.goodBandMin) {
    error = -(slack - A.targetSlackMin - A.goodBandMin);
    step = Math.max(A.alphaEarly * error, -A.maxDownMin);
  }
  const raw = round1(prev + step), next = clamp(raw, A.minOffsetMin, A.maxOffsetMin);
  return {
    offsetMin: next, prevOffsetMin: prev, deltaMin: round1(next - prev), slackMin: round1(slack), errorMin: round1(error),
    verdict: verdictOf(slack), limited: raw > A.maxOffsetMin ? 'max' : raw < A.minOffsetMin ? 'min' : null,
  };
}

/**
 * 도착 기록 한 건과 새 보정 상태(같은 날 같은 수업은 한 번만 — 부르는 쪽에서 key로 확인)
 * @param {{offsetMin,samples}} personal  @param {{ key, dateKey, cls, arriveMin, at }} p  at = 기록 시각(ISO 등)
 */
export function recordArrival(personal, { key, dateKey, cls, arriveMin, at }) {
  const r = learnOffset(personal?.offsetMin, { arriveMin, startMin: toMin(cls.start) });
  const record = { key, dateKey, classId: cls.id, name: String(cls.name || '').slice(0, 40), start: cls.start, at, arriveMin: round1(arriveMin), ...r };
  return { record, personal: { offsetMin: r.offsetMin, samples: (Number(personal?.samples) || 0) + 1, updatedAt: at } };
}
export const keepArrivals = (list) => (Array.isArray(list) ? list.slice(-ARRIVAL.keep) : []);

/** 잘못 누른 기록 되돌리기: 가장 최근 기록만(그 앞 보정값으로 돌아감). 안 되면 null */
export function undoArrival(personal, arrivals, key, at = null) {
  const list = Array.isArray(arrivals) ? arrivals : [];
  const last = list[list.length - 1];
  if (!last || last.key !== key) return null;
  return {
    personal: { offsetMin: personalOffset(last.prevOffsetMin), samples: Math.max(0, (Number(personal?.samples) || 1) - 1), updatedAt: at },
    arrivals: list.slice(0, -1), removed: last,
  };
}

/* ── 화면 문구 ── */
/** '+3분' · '−2분' · '0분' */
export function personalLabel(offsetMin) {
  const n = appliedOffset(offsetMin);
  return n > 0 ? `+${n}분` : n < 0 ? `−${-n}분` : '0분';
}
/** 내 걸음 반영 상태 한 줄 */
export function personalText(personal) {
  const n = appliedOffset(personal?.offsetMin);
  if (!personal?.samples && !n) return '아직 도착 기록이 없어요. ‘도착했어요!’를 누를수록 내 걸음에 맞춰져요';
  if (n > 0) return `평소보다 ${n}분 더 걸린다고 보고, ${n}분 일찍 도착하도록 출발 시각을 잡아요`;
  if (n < 0) return `평소보다 ${-n}분 덜 걸린다고 보고 출발 시각을 잡아요`;
  return '지금은 보정 없이 계산해요';
}
/** '수업 2분 전' · '수업 시작 직전' · '수업 시작 3분 뒤' */
export function slackText(slackMin) {
  if (slackMin >= 1) return `수업 ${Math.floor(slackMin + 1e-9)}분 전`;
  if (slackMin >= 0) return '수업 시작 직전';
  return `수업 시작 ${Math.ceil(-slackMin - 1e-9)}분 뒤`;
}
const VERDICT = { late: '늦었어요', tight: '조금 빠듯했어요', good: '딱 좋아요', early: '넉넉했어요' };

/** 버튼을 누른 뒤 피드백: { title, when, verdict, change, status } */
export function arrivalFeedback(record) {
  const A = ARRIVAL, d = appliedOffset(record.offsetMin) - appliedOffset(record.prevOffsetMin);
  let change;
  if (record.limited === 'max' && d <= 0) change = `보정이 이미 최대(+${A.maxOffsetMin}분)예요. 설정에서 ‘정류장까지 걸어서’ 시간을 늘려 보세요`;
  else if (record.limited === 'min' && d >= 0) change = `보정이 이미 최소(−${-A.minOffsetMin}분)라 지금처럼 안내할게요`;
  else if (d > 0) change = `다음부터 평소보다 ${d}분 일찍 도착하도록 안내할게요`;
  else if (d < 0) change = `다음부터 ${-d}분 덜 서둘러도 되게 안내할게요`;
  else if (record.deltaMin !== 0) change = '아직은 지금처럼 안내해요 · 같은 일이 반복되면 맞춰 갈게요';
  else change = '지금처럼 안내할게요';
  return {
    title: '도착 기록 완료!',
    when: `${toHHMM(Math.floor(record.arriveMin + 1e-9))} 도착 · ${slackText(record.slackMin)}`,
    verdict: VERDICT[record.verdict] || '',
    change,
    status: `내 걸음 반영 ${personalLabel(record.offsetMin)}`,
  };
}
