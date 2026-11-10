// 노선 설정 예시와 모의(예시) 교통 상황 — 실제 서울시 데이터가 아닙니다.
// 실제 운영에서는 백엔드가 서울시 버스 API로 liveMin(실시간 소요)을, 쌓인 기록으로 usualMin(평소 소요)을 채웁니다.

/** 이용 노선 예시. usualMin은 '내 승차 정류장 → 학교 하차 정류장' 평소 소요(분)로 사용자가 고칠 수 있습니다. */
export const EXAMPLE_ROUTES = [
  { id: '171', no: '171', type: '간선', gate: '정문', stop: '국민대학교앞', usualMin: 12, corridor: '정릉로', enabled: true },
  { id: '1711', no: '1711', type: '지선', gate: '정문', stop: '국민대앞', usualMin: 14, corridor: '정릉로', enabled: true },
  { id: '1112', no: '1112', type: '지선', gate: '후문', stop: '국민대후문', usualMin: 13, corridor: '정릉로9길', enabled: true },
];

/** 모의 시나리오: 도로별 최대 추가 지연(분)과 정체가 가장 심한 시각(분) */
export const SCENARIOS = {
  jeongneung: { label: '정릉로 출근길 정체', cause: '정릉로', roads: { 정릉로: 8 }, peakMin: 8 * 60 + 20, widthMin: 40 },
  backgate: { label: '후문 쪽 정체', cause: '정릉로9길', roads: { 정릉로9길: 7 }, peakMin: 8 * 60 + 20, widthMin: 40 },
  rain: { label: '비 오는 날(전 노선 30% 지연)', cause: '빗길', roads: {}, ratio: 1.3 },
  normal: { label: '평소(원활)', cause: null, roads: {} },
};

/** 시각 nowMin(분)에서 도로별 추가 지연(분). 정체는 peakMin에서 최대, 앞뒤로 종 모양으로 줄어듭니다. */
export function roadDelays(scenarioId, nowMin) {
  const sc = SCENARIOS[scenarioId] || SCENARIOS.normal, out = {};
  for (const [road, peak] of Object.entries(sc.roads)) {
    const k = sc.peakMin == null ? 1 : Math.exp(-(((nowMin - sc.peakMin) / sc.widthMin) ** 2));
    out[road] = Math.round(peak * Math.max(k, 0.12) * 10) / 10;
  }
  return out;
}

/** 노선 목록에 모의 실시간 소요(liveMin)를 채워 돌려줍니다. 원인 도로(cause)도 함께. */
export function mockLive(routes, scenarioId, nowMin) {
  const sc = SCENARIOS[scenarioId] || SCENARIOS.normal, rd = roadDelays(scenarioId, nowMin);
  const live = routes.map((r) => {
    let m = r.usualMin * (sc.ratio || 1) + (rd[r.corridor] || 0);
    return { ...r, liveMin: Math.round(m), source: 'mock' };
  });
  const worst = Object.entries(rd).sort((a, b) => b[1] - a[1])[0];
  return { routes: live, cause: sc.ratio ? sc.cause : worst && worst[1] >= 2 ? worst[0] : null, roadDelays: rd, scenario: scenarioId, label: sc.label };
}
