// 1분마다 모든 사용자의 오늘 계획을 계산해, 보낼 알림이 있으면 Web Push로 보내고 기록합니다.
// - 실시간 조회는 첫 수업 3시간 전부터 수업 시작까지만(서울시 API 호출 절약). 캐시(30초)를 거쳐 같은 노선은 한 번만 호출.
// - 예시(모의) 데이터로 계산된 알림은 본문에 출처를 밝힙니다(PUSH_WHEN_MOCK=skip이면 보내지 않음).
import { planFor } from './planner.js';

export const MOCK_NOTE = ' (예시 교통 데이터 기준 · 실시간 아님)';

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
          const { plan, alarms, key, mockData } = await planFor(user, provider, now(), { windowMin });
          if (!plan || !alarms.length) continue;
          if (mockData && pushWhenMock === 'skip') { stats.skippedMock += alarms.length; continue; }
          for (const a of alarms) {
            const body = mockData ? `${a.body}${MOCK_NOTE}` : a.body;
            const gone = await pusher.send(user.push, { title: a.title, body, tag: `${key}:${a.type}`, level: a.level, url: '/', source: mockData ? 'mock' : 'seoul' });
            store.update(userId, (u) => {
              u.push = u.push.filter((s) => !gone.includes(s.endpoint));
              const rec = u.fired[key] || (u.fired[key] = {});
              if (a.type === 'worse') rec.delay = { delayMin: a.delayMin }; else rec[a.type] = { delayMin: a.delayMin };
            });
            sent.push({ userId, type: a.type, title: a.title, body, source: mockData ? 'mock' : 'seoul' });
          }
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
