// 사용자 한 명의 오늘 등교 추천 — 화면(App.jsx)과 같은 shared/recommend.js(recommend·decideAlarms)를 씁니다.
//   탑승 정류장 하나 → 국민대행 노선(서울시 실시간, 실패 시 예시 데이터) → '몇 시에 나가서 몇 번 버스'
import { recommend, decideAlarms, firstClassOf } from '../../shared/recommend.js';
import { WALK_TABLE } from '../../shared/campusData.js';
import { seoulParts, toMin } from '../../shared/time.js';

export function walkTableFor(user) {
  const t = {};
  for (const [b, row] of Object.entries(WALK_TABLE)) t[b] = { ...row, ...(user.walkOverrides?.[b] || {}) };
  return t;
}

/**
 * @param {object} user  { classes, stop:{arsId,name}, prefs:{walkToStopMin, marginMin, notify, notifyBeforeMin}, walkOverrides, fired }
 * @param {object} provider  createLiveService() 또는 createMockProvider() — stopTrips(arsId, now)
 * @param {object} [opt]
 * @param {number} [opt.windowMin] 수업 시작 몇 분 전부터 실시간을 조회할지(스케줄러가 서울시 API 호출을 아끼려고 씀). 화면 요청은 제한 없음
 * @returns {Promise<{ now, cls, rec, live, alarms, key, mockData }>}
 */
export async function planFor(user, provider, nowDate = new Date(), { windowMin = Infinity } = {}) {
  const now = seoulParts(nowDate);
  const cls = now.weekday < 5 ? firstClassOf(user.classes, now.weekday) : null;
  if (!user.stop?.arsId) return { now, cls, rec: { state: 'no-stop' }, live: null, alarms: [], key: null, mockData: false };
  const start = cls ? toMin(cls.start) : NaN;
  const due = Boolean(cls) && now.minutes < start && start - now.minutes <= windowMin;
  const live = due ? await provider.stopTrips(user.stop.arsId, nowDate) : null;
  const rec = recommend({
    trips: live?.trips || [], cls, nowMin: now.minutes, walkTable: walkTableFor(user),
    walkToStopMin: user.prefs.walkToStopMin, marginMin: user.prefs.marginMin,
  });
  // 예시 데이터로 계산한 알림은 기록 키를 따로 → 서울시 실시간이 돌아오면 실제 값으로 다시 판단(화면 useAlarms와 같은 규칙)
  const mockData = live?.source === 'mock';
  const key = cls ? `${now.dateKey}:${cls.id}${mockData ? ':mock' : ''}` : null;
  const alarms = due && user.prefs.notify && rec.state === 'ok'
    ? decideAlarms({ rec, nowMin: now.minutes, fired: user.fired[key] || {}, notifyBeforeMin: user.prefs.notifyBeforeMin })
    : [];
  return { now, cls, rec, live, alarms, key, mockData };
}
