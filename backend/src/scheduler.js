// 1분마다 모든 사용자의 오늘 추천을 다시 계산해, 보낼 알림이 있으면 Web Push로 보내고 기록합니다.
// - 실시간 조회는 첫 수업 3시간 전부터 수업 시작까지만(서울시 API 호출 절약). 같은 정류장은 캐시를 거쳐 한 번만 호출.
// - 동시에 걸린 알림(예: 출발 10분 전 + 빠듯)은 화면처럼 하나로 합쳐 보냅니다.
// - 예시(모의) 데이터로 계산된 알림은 본문에 출처를 밝힙니다(PUSH_WHEN_MOCK=skip이면 보내지 않음).
import { planFor } from './planner.js';

export const MOCK_NOTE = ' (예시 교통 데이터 기준 · 실시간 아님)';
const SEVERITY = { danger: 2, warn: 1 };

export function createScheduler({ store, provider, pusher, now = () => new Date(), intervalMs = 60000, windowMin = 180, pushWhenMock = 'label', log = console }) {
  let timer = null, running = false;
  const stats = { lastTickAt: null, ticks: 0, sent: 0, skippedMock: 0, lastError: null };
  async function tick() {
    if (running) return [];
    running = true;
    const sent = [];
    try {
      for (const [userId, user] of store.users()) {
        try {
          const { alarms, key, mockData } = await planFor(user, provider, now(), { windowMin });
          if (!alarms.length) continue;
          if (mockData && pushWhenMock === 'skip') { stats.skippedMock += alarms.length; continue; }
          const main = alarms.find((a) => a.type === 'depart') || alarms.find((a) => a.type === 'earlier') || alarms[0];
          const tone = alarms.reduce((t, a) => ((SEVERITY[a.tone] || 0) > (SEVERITY[t] || 0) ? a.tone : t), main.tone);
          const body = mockData ? `${main.body}${MOCK_NOTE}` : main.body;
          const gone = await pusher.send(user.push, { title: main.title, body, tag: `${key}:${main.type}`, level: tone, url: '/', source: mockData ? 'mock' : 'seoul' });
          store.update(userId, (u) => {
            u.push = u.push.filter((s) => !gone.includes(s.endpoint));
            const rec = u.fired[key] || (u.fired[key] = {});
            for (const a of alarms) { if (a.type === 'earlier') rec.depart = { departMin: a.departMin }; else rec[a.type] = { departMin: a.departMin }; }
          });
          sent.push({ userId, types: alarms.map((a) => a.type), title: main.title, body, source: mockData ? 'mock' : 'seoul' });
        } catch (e) { stats.lastError = e.message; log.warn?.(`[scheduler] ${userId}: ${e.message}`); }
      }
    } finally {
      running = false;
      stats.lastTickAt = now().toISOString(); stats.ticks++; stats.sent += sent.length;
    }
    return sent;
  }
  return {
    tick,
    status: () => ({ running: Boolean(timer), intervalSec: intervalMs / 1000, windowMin, pushWhenMock, ...stats }),
    start() { if (!timer) { timer = setInterval(tick, intervalMs); tick(); } return this; },
    stop() { clearInterval(timer); timer = null; },
  };
}
