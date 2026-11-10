// 권장 출발 시각 계산·대체 노선·알림 판정 — 프론트엔드와 백엔드가 같은 코드를 씁니다(순수 함수).
//
//   권장 출발 시각 = 수업 시작 시각 − (실시간 버스 소요시간 + 건물 도보시간 + 여유시간 5분)
//   목표 학교 도착(하차) 시각 = 수업 시작 시각 − 건물 도보시간 − 여유시간
//   알림 시각 = 권장 출발 시각 − N분(기본 10분)
import { DEFAULT_WALK_MIN } from './campusData.js';
import { toMin, toHMM, toHHMM } from './time.js';

export const DEFAULT_MARGIN_MIN = 5;          // 여유시간
export const DEFAULT_NOTIFY_BEFORE_MIN = 10;  // 출발 N분 전 알림
export const DELAY_ALERT_MIN = 3;             // 평소보다 3분 이상 늦으면 '지연'으로 알림
export const WORSEN_STEP_MIN = 3;             // 알림 뒤 지연이 3분 더 늘면 다시 알림
export const EARLY_WARNING_MIN = 30;          // 지연이면 출발 알림보다 최대 30분 먼저 경고

/** 하차 문(정문/후문) → 건물 도보시간(분). 지정 데이터가 없으면 기본 5분 */
export function walkMinutes(table, building, gate) {
  const v = table?.[building]?.[gate];
  return Number.isFinite(v) ? v : DEFAULT_WALK_MIN;
}

/** 노선 상태 칩: 원활 / +N분 지연 */
export function routeStatus(delayMin) {
  if (delayMin >= 5) return { level: 'danger', label: `+${delayMin}분 지연` };
  if (delayMin >= 2) return { level: 'warn', label: `+${delayMin}분 지연` };
  return { level: 'ok', label: '원활' };
}

/** 그날(weekday 0=월) 가장 이른 수업 */
export function firstClassOf(classes, weekday) {
  return (classes || []).filter((c) => c.day === weekday && Number.isFinite(toMin(c.start)))
    .sort((a, b) => toMin(a.start) - toMin(b.start))[0] || null;
}

/** 노선 하나에 대한 계산 */
export function planRoute({ cls, route, walkTable, marginMin = DEFAULT_MARGIN_MIN }) {
  const classStartMin = toMin(cls.start);
  const walkMin = walkMinutes(walkTable, cls.building, route.gate);
  const targetArrivalMin = classStartMin - walkMin - marginMin;
  const delayMin = Math.max(0, Math.round(route.liveMin - route.usualMin));
  return {
    ...route, walkMin, marginMin, classStartMin, targetArrivalMin, delayMin,
    departLiveMin: targetArrivalMin - route.liveMin,
    departUsualMin: targetArrivalMin - route.usualMin,
    status: routeStatus(delayMin),
  };
}

/**
 * 첫 수업 하나에 대한 통합 계획(권장 출발·지연·대체 노선·알림 문구)
 * @param {object} p
 * @param {{id,name,day,start,end,building,room}} p.cls
 * @param {Array<{id,no,gate,usualMin,liveMin,enabled?}>} p.routes  실시간 소요(liveMin)가 채워진 노선 목록
 * @param {string} p.primaryId  평소 타는 노선
 * @param {string} [p.cause]    정체 원인 도로명(예: '정릉로')
 */
export function buildPlan({ cls, routes, primaryId, walkTable, marginMin = DEFAULT_MARGIN_MIN, notifyBeforeMin = DEFAULT_NOTIFY_BEFORE_MIN, cause }) {
  if (!cls) return null;
  const usable = (routes || []).filter((r) => r.enabled !== false && Number.isFinite(r.liveMin) && Number.isFinite(r.usualMin));
  if (!usable.length) return null;
  const plans = usable.map((route) => planRoute({ cls, route, walkTable, marginMin }));
  const primary = plans.find((p) => p.id === primaryId) || plans[0];
  const best = plans.reduce((a, b) => (b.departLiveMin > a.departLiveMin ? b : a));
  const delayed = primary.delayMin >= DELAY_ALERT_MIN;
  const alt = best !== primary && best.departLiveMin > primary.departLiveMin
    ? { route: best, onTime: best.departLiveMin >= primary.departUsualMin, gainMin: best.departLiveMin - primary.departLiveMin }
    : null;
  const rec = primary.departLiveMin;
  let message;
  if (delayed) {
    message = `현재 ${cause || '교통'} 정체로 ${primary.no}번 ${primary.delayMin}분 지연! ${toHMM(rec)}까지 출발을 권장합니다.`;
    if (alt) message += alt.onTime
      ? ` (대체 추천: ${alt.route.gate} 방향 ${alt.route.no}번 탑승 시 정시 출발 가능)`
      : ` (대체 추천: ${alt.route.gate} 방향 ${alt.route.no}번 탑승 시 ${toHMM(alt.route.departLiveMin)} 출발, ${alt.gainMin}분 여유)`;
  } else {
    message = `${primary.no}번 평소대로 운행 중이에요. ${toHMM(rec)}에 출발하면 ${cls.name} 수업에 여유 있게 도착해요.`;
  }
  return {
    cls, classStartMin: primary.classStartMin, plans: [...plans].sort((a, b) => b.departLiveMin - a.departLiveMin),
    primaryFallback: primary.id !== primaryId, // 주 노선 실시간 정보가 없어 다른 노선으로 계산했는지
    primary, alt, delayed, cause: cause || null, level: delayed ? primary.status.level : 'ok',
    targetArrivalMin: primary.targetArrivalMin, recommendedDepartMin: rec, alarmAtMin: rec - notifyBeforeMin,
    notifyBeforeMin, message,
  };
}

/**
 * 지금 보내야 할 알림 목록. fired는 이미 보낸 알림 기록({ delay:{delayMin}, depart:{...} }) — 같은 날 같은 수업 기준.
 * 종류: delay(지연 조기 경고) · worse(지연 악화) · depart(출발 N분 전, 지났으면 즉시 출발 안내)
 */
export function decideAlarms({ plan, nowMin, fired = {} }) {
  if (!plan || nowMin >= plan.classStartMin) return [];
  const out = [], p = plan.primary, dep = plan.recommendedDepartMin, alarmAt = plan.alarmAtMin;
  const base = { level: plan.level, departMin: dep, delayMin: p.delayMin };
  if (plan.delayed && nowMin < dep) {
    if (!fired.delay && nowMin >= alarmAt - EARLY_WARNING_MIN) {
      out.push({ ...base, type: 'delay', title: `지연 알림 · ${p.no}번 +${p.delayMin}분`, body: plan.message });
    } else if (fired.delay && p.delayMin >= fired.delay.delayMin + WORSEN_STEP_MIN) {
      out.push({ ...base, type: 'worse', title: `지연이 늘었어요 · ${p.no}번 +${p.delayMin}분`, body: plan.message });
    }
  }
  if (!fired.depart && nowMin >= alarmAt) {
    const left = Math.ceil(dep - nowMin);
    const detail = `${plan.cls.name} ${plan.cls.start} · ${plan.cls.building} — ${p.no}번 ${p.liveMin}분 + 도보 ${p.walkMin}분 + 여유 ${p.marginMin}분`;
    if (left > 0) out.push({ ...base, type: 'depart', title: `${left}분 뒤 출발하세요 (${toHHMM(dep)})`, body: plan.delayed ? plan.message : detail });
    else {
      const altOk = plan.alt && plan.alt.route.departLiveMin > nowMin;
      out.push({ ...base, type: 'depart', level: 'danger', title: `권장 출발 시각(${toHHMM(dep)})이 지났어요`,
        body: altOk ? `지금 바로 출발하거나 ${plan.alt.route.no}번(${plan.alt.route.gate})을 이용하세요. ${toHHMM(plan.alt.route.departLiveMin)}까지 출발하면 됩니다.` : `지금 바로 출발하세요. ${detail}` });
    }
  }
  return out;
}

/**
 * 계획 문구에 쓸 정체 원인: 주 노선의 원인 → 전체 원인. 백엔드(planner)와 프런트엔드(App)가 같은 함수를 써서 문구가 같게 나옵니다.
 * @param {{ routes?:Array<{id:string, cause?:string|null}>, cause?:string|null }} live
 */
export function causeFor(live, primaryId) {
  const p = (live?.routes || []).find((r) => r.id === primaryId);
  return p?.cause ?? live?.cause ?? null;
}

/** 화면의 계산식 표시용 */
export function formulaParts(plan) {
  const p = plan.primary;
  return { classStart: toHHMM(plan.classStartMin), busMin: p.liveMin, walkMin: p.walkMin, marginMin: p.marginMin, depart: toHHMM(plan.recommendedDepartMin), target: toHHMM(plan.targetArrivalMin) };
}
