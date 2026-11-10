// 사용자 한 명의 '오늘 등교 계획' 계산 — 프런트엔드와 같은 shared/departure.js(buildPlan·causeFor·decideAlarms)를 씁니다.
import { buildPlan, causeFor, decideAlarms, firstClassOf } from '../../shared/departure.js';
import { WALK_TABLE } from '../../shared/campusData.js';
import { seoulParts, toMin } from '../../shared/time.js';

export function walkTableFor(user) {
  const t = {};
  for (const [b, row] of Object.entries(WALK_TABLE)) t[b] = { ...row, ...(user.walkOverrides?.[b] || {}) };
  return t;
}

/**
 * @param {object} [opt]
 * @param {number} [opt.windowMin] 수업 시작 몇 분 전부터만 실시간을 조회할지(스케줄러가 API 호출을 아끼려고 씀). 기본 제한 없음
 * @returns {Promise<{ now, plan, live, alarms, key }>} plan이 null이면 오늘 등교할 수업 없음(또는 조회 시간대 밖)
 */
export async function planFor(user, provider, nowDate = new Date(), { windowMin = Infinity } = {}) {
  const now = seoulParts(nowDate);
  const cls = now.weekday < 5 ? firstClassOf(user.classes, now.weekday) : null;
  const start = cls ? toMin(cls.start) : NaN;
  const inWindow = cls && (windowMin === Infinity || (now.minutes >= start - windowMin && now.minutes < start));
  const routes = (user.routes || []).filter((r) => r.enabled !== false);
  const live = inWindow ? await provider.live(routes, nowDate) : { routes: [], cause: null, source: provider.name, provider: provider.name };
  const plan = buildPlan({
    cls: inWindow ? cls : null, routes: live.routes, primaryId: user.primaryRouteId, walkTable: walkTableFor(user),
    marginMin: user.settings.marginMin, notifyBeforeMin: user.settings.notifyBeforeMin, cause: causeFor(live, user.primaryRouteId),
  });
  // 예시(모의) 데이터로 계산한 알림은 기록 키를 따로 → 서울시 실시간이 돌아오면 실제 값으로 다시 판단(화면 useAlarms와 같은 규칙)
  const mockData = Boolean(plan) && (plan.primary.source === 'mock' || live.source === 'mock');
  const key = plan ? `${now.dateKey}:${plan.cls.id}${mockData ? ':mock' : ''}` : null;
  const alarms = plan ? decideAlarms({ plan, nowMin: now.minutes, fired: user.fired[key] || {} }) : [];
  return { now, plan, live, alarms, key, mockData };
}
