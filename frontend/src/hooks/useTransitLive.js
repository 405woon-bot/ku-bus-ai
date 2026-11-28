import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { sampleTransitLive } from '@source';

const REFRESH_MS = 30000;
/** v2.6.0 환승 구간(종류와 상관없이): 받은 열차 · 버스가 있는 것만 줄임(v2.7.0 중간 환승 버스 buses도 같은 모양) */
function shiftMid(m, sec) {
  if (!m) return m;
  const out = { ...m };
  if (Array.isArray(m.trains)) out.trains = m.trains.map((t) => ({ ...t, etaSec: t.etaSec - sec })).filter((t) => t.etaSec > -30);
  if (Array.isArray(m.buses)) out.buses = m.buses.map((b) => ({ ...b, etasSec: (b.etasSec || []).map((v) => v - sec).filter((v) => v > -30) }));
  return out;
}
/** 받은 뒤 흐른 초만큼 도착 예정을 줄임(카운트다운) */
function shift(live, sec) {
  if (!live || !sec) return live;
  const s = (a) => (a || []).map((v) => v - sec).filter((v) => v > -30);
  return {
    ...live,
    first: live.first && { ...live.first, trains: (live.first.trains || []).map((t) => ({ ...t, etaSec: t.etaSec - sec })).filter((t) => t.etaSec > -30), buses: (live.first.buses || []).map((b) => ({ ...b, etasSec: s(b.etasSec) })) },
    mid: shiftMid(live.mid, sec), // v2.6.0 환승 구간
    final: live.final && { ...live.final, trips: (live.final.trips || []).map((t) => ({ ...t, etasSec: s(t.etasSec) })) },
  };
}

/**
 * 저장한 환승 경로의 실시간 재료(첫 지하철 · 버스, 마지막 국민대행 버스, v2.6.0 환승 지하철)
 *   midHint = { i, at } — '출발했어요!' 뒤 다음 탈 환승 구간(shared midHint — 지금은 지하철만). 있으면 서버에 ?next=&at=로 알려 줌(서버가 ±15분 · 하루 몫을 확인)
 *   api: 30초마다 /api/transit/live — 지하철 실시간은 서버가 출발 30분 전부터만 받아 옴(하루 한도 아끼기)
 *   sample: 예시 응답(실시간 아님)
 * @returns {{ status:'idle'|'loading'|'ok'|'error', rt, fetchedAt?, sample?, error? }}  rt는 지금 기준으로 맞춘 도착 예정
 */
export function useTransitLive({ mode, route, now, cls, walkTable, marginMin, personalOffsetMin, departedMin = null, preview = null, midHint = null }) {
  const key = route ? route.title + route.legs.length : '';
  const bucket = Math.floor(now.minutes * 12); // 시계 5초마다(미리보기 '시각 이동'도 바로 반영)
  const pv = preview || {};
  // v2.2 미리보기: '출발했어요!'를 눌렀으면 그 출발 시각 기준으로 첫 지하철 실시간 시간대를 정함(실서비스는 서버가 저장한 기록으로)
  const sample = useMemo(() => (mode === 'sample' && route ? sampleTransitLive(route, now, { cls, walkTable, marginMin, personalOffsetMin, preview: pv, departedMin, midHint }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, key, bucket, cls?.id, marginMin, personalOffsetMin, departedMin, pv.incidents, pv.weather, pv.explain, midHint?.i, midHint?.at]);
  // v2.6.0 30초마다 부를 때 가장 새로운 '다음 탈 환승 지하철'을 씀 — 구간이 바뀌면(첫 구간을 탄 뒤 등) 바로 한 번 더
  const midRef = useRef(midHint);
  midRef.current = midHint;
  const loadRef = useRef(null);
  // v2.8.0 가장 나중에 보낸 요청의 답만 씀 — 앱을 열 때 '다음 탈 환승 구간'을 알기 전 요청과 안 뒤 요청이 함께 나가는데,
  //   앞 요청의 답이 늦게 오면 환승 구간 실시간('환승 버스 실시간' 등)을 지워 다음 갱신(30초)까지 안 보였음
  const seqRef = useRef(0);
  const [live, setLive] = useState({ status: 'idle', rt: null });
  useEffect(() => {
    if (mode !== 'api' || !route) { setLive({ status: 'idle', rt: null }); return undefined; }
    let alive = true;
    setLive((l) => ({ ...l, status: l.rt ? l.status : 'loading' }));
    const load = () => {
      const n = ++seqRef.current;
      return api.transitLive(midRef.current).then((j) => { if (alive && n === seqRef.current) setLive({ status: 'ok', rt: j, at: Date.now() }); })
        .catch((e) => { if (alive && n === seqRef.current) setLive((l) => ({ ...l, status: l.rt ? 'stale' : 'error', error: e.message })); });
    };
    loadRef.current = load;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; loadRef.current = null; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, key]);
  const midLeg = midHint?.i ?? null;
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; } // 처음에는 위에서 이미 부름
    if (midLeg != null) loadRef.current?.();
  }, [midLeg]);
  const tick = Math.floor(Date.now() / 5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const adjusted = useMemo(() => (live.at ? { ...live, rt: shift(live.rt, (Date.now() - live.at) / 1000) } : live), [live, tick]);
  if (!route) return { status: 'idle', rt: null };
  return mode === 'sample' ? { status: 'ok', rt: sample, sample: true } : adjusted;
}
