// '몇 시에 나가서 몇 번 버스를 타면 늦지 않는가' 계산 — 실시간 도착 예측과 구간 속도만 사용합니다(평소 소요시간 없음).
//
//   후보 버스 = 노선별 실시간 도착 예측 2대 + 그 뒤는 배차간격으로 이어 붙인 예상 차
//   강의실 도착 = 탑승 시각 + 차내 시간(실시간 구간 속도) + 하차 문→강의 건물 도보
//   추천 = 수업 시작 '여유시간(5분)' 전까지 도착하는 차 중 가장 늦게 타도 되는 차
//   출발 시각 = 추천 차 탑승 시각 − 정류장까지 걸어가는 시간(기본 5분)
import { DEFAULT_WALK_MIN } from './campusData.js';
import { toMin, toHHMM } from './time.js';

export const DEFAULTS = { marginMin: 5, walkToStopMin: 5, notifyBeforeMin: 10 };
export const STATUS = { relaxed: { label: '여유', tone: 'ok' }, tight: { label: '빠듯', tone: 'warn' }, late: { label: '지각 위험', tone: 'danger' } };

/** 그날(weekday 0=월) 가장 이른 수업 */
export function firstClassOf(classes, weekday) {
  return (classes || []).filter((c) => c.day === weekday && Number.isFinite(toMin(c.start))).sort((a, b) => toMin(a.start) - toMin(b.start))[0] || null;
}

export function walkToBuilding(table, building, gate) {
  const v = table?.[building]?.[gate];
  return Number.isFinite(v) ? v : DEFAULT_WALK_MIN;
}

/**
 * 탑승 가능 시각 목록(분): 실시간 2대(live) + 배차간격 예상(live=false).
 * 운행이 끝난 노선은 없음, 둘째 차가 '운행종료'(막차)면 배차간격으로 잇지 않습니다.
 */
export function busTimes(trip, nowMin, untilMin) {
  if (trip.ended) return [];
  const out = trip.etasSec.map((s, i) => ({ boardMin: nowMin + s / 60, live: true, order: i }));
  const lastBus = /운행\s*종료/.test(trip.msgs?.[1] || '');
  if (trip.termMin && !lastBus) {
    let last = out.length ? out[out.length - 1].boardMin : nowMin;
    while (out.length < 60 && last + trip.termMin <= untilMin) { last += trip.termMin; out.push({ boardMin: last, live: false, order: out.length }); }
  }
  return out;
}

/**
 * @param {object} p
 * @param {Array} p.trips  computeTrips 결과(노선별 etasSec, termMin, inVehicleMin, gate, congestion…)
 * @param {{name,start,building,room}} p.cls 오늘 첫 수업
 * @returns {{state:'ok'|'no-class'|'started'|'no-trip', pick?, status?, slackMin?, nextBus?}}
 */
export function recommend({ trips, cls, nowMin, walkTable, walkToStopMin = DEFAULTS.walkToStopMin, marginMin = DEFAULTS.marginMin }) {
  if (!cls) return { state: 'no-class' };
  const start = toMin(cls.start);
  if (nowMin >= start) return { state: 'started', cls };
  const cands = [];
  for (const trip of trips || []) {
    const walkMin = walkToBuilding(walkTable, cls.building, trip.gate);
    for (const b of busTimes(trip, nowMin, start)) {
      const departMin = b.boardMin - walkToStopMin;
      if (departMin < nowMin - 0.25) continue; // 지금 나가도 못 타는 차
      cands.push({ trip, ...b, departMin, classArriveMin: b.boardMin + trip.inVehicleMin + walkMin });
    }
  }
  if (!cands.length) return { state: 'no-trip', cls };
  const ok = cands.filter((c) => c.classArriveMin <= start - marginMin);
  const pick = ok.length
    ? ok.reduce((a, b) => (b.boardMin > a.boardMin + 1e-6 || (Math.abs(b.boardMin - a.boardMin) <= 1e-6 && b.classArriveMin < a.classArriveMin) ? b : a))
    : cands.reduce((a, b) => (b.classArriveMin < a.classArriveMin ? b : a));
  const slackMin = start - pick.classArriveMin;
  const status = slackMin >= marginMin ? 'relaxed' : slackMin >= 0 ? 'tight' : 'late';
  const nextSec = pick.trip.etasSec[0];
  return {
    state: 'ok', cls, classStartMin: start, pick, status, slackMin,
    departNow: pick.departMin <= nowMin + 0.5,
    nextBus: { no: pick.trip.no, inMin: Number.isFinite(nextSec) ? nextSec / 60 : null, isPick: pick.live && pick.order === 0, congestion: pick.trip.congestion },
  };
}

/** 지금 보낼 알림: 출발 N분 전 · 출발 시각이 3분 이상 앞당겨짐 · 빠듯/지각 위험. fired: 그날 그 수업에 이미 보낸 기록 */
export function decideAlarms({ rec, nowMin, fired = {}, notifyBeforeMin = DEFAULTS.notifyBeforeMin }) {
  if (!rec || rec.state !== 'ok') return [];
  const p = rec.pick, t = p.trip, st = STATUS[rec.status];
  const ride = `${t.no}번 ${toHHMM(p.boardMin)} 탑승 · 강의실 ${toHHMM(p.classArriveMin)} 도착 예정(${st.label})`;
  const out = [];
  if (!fired.depart && nowMin >= p.departMin - notifyBeforeMin) {
    const left = Math.ceil(p.departMin - nowMin);
    out.push({ type: 'depart', tone: st.tone, departMin: p.departMin, title: left > 0 ? `${left}분 뒤 출발하세요 (${toHHMM(p.departMin)})` : '지금 출발하세요', body: ride });
  } else if (fired.depart && p.departMin <= fired.depart.departMin - 3) {
    out.push({ type: 'earlier', tone: 'warn', departMin: p.departMin, title: `출발 시각이 ${toHHMM(p.departMin)}로 앞당겨졌어요`, body: `도로 정체가 늘었어요. ${ride}` });
  }
  if (rec.status !== 'relaxed' && !fired.risk) {
    out.push({ type: 'risk', tone: st.tone, departMin: p.departMin, title: rec.status === 'late' ? '지각 위험이에요' : '도착이 빠듯해요', body: `${ride}. ${rec.status === 'late' ? '지금 바로 출발하세요.' : '서둘러 주세요.'}` });
  }
  return out;
}
