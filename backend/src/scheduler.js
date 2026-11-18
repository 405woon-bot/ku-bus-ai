// 1분마다 모든 사용자의 오늘 추천을 다시 계산해, 보낼 알림이 있으면 Web Push로 보내고 기록합니다.
// - 실시간 조회는 첫 수업 3시간 전부터 수업 시작까지만(서울시 API 호출 절약). 같은 정류장은 캐시를 거쳐 한 번만 호출.
// - 동시에 걸린 알림(예: 출발 10분 전 + 빠듯)은 화면처럼 하나로 합쳐 보냅니다.
// - 예시(모의) 데이터로 계산된 알림은 본문에 출처를 밝힙니다(PUSH_WHEN_MOCK=skip이면 보내지 않음).
// - 보낼 때마다 수신 확인 번호를 실어 보내고 기록(pushLog) — 휴대폰 서비스 워커가 '받았음'을 알리면 설정 화면에 '수신 확인됨'
// - Render 무료 서버는 15분 동안 접속이 없으면 잠들어 이 1분 타이머도 멈춥니다 → cron-job.org가 /api/wake로 깨워 둠(README)
// - v2.1: 같은 타이머로 밤에 주요 환승역 경로를 미리 찾아 둠(warmer.step — 시간 · 남은 한도를 스스로 확인)
import { planFor } from './planner.js';
import { sendAndLog } from './push.js';

export const MOCK_NOTE = ' (예시 교통 데이터 기준 · 실시간 아님)';
const SEVERITY = { danger: 2, warn: 1 };

export function createScheduler({ store, provider, pusher, now = () => new Date(), intervalMs = 60000, windowMin = 180, pushWhenMock = 'label', log = console, subway = null, warmer = null }) {
  let timer = null, running = false;
  const stats = { lastTickAt: null, ticks: 0, sent: 0, skippedMock: 0, lastError: null };
  async function tick() {
    // v2.1 밤에 주요 환승역 경로 미리 찾기(정해진 시간 · 남은 한도일 때만 한 곳) — 알림 계산을 기다리게 하지 않음
    if (warmer) warmer.step(now()).catch(() => {});
    if (running) return [];
    running = true;
    const sent = [];
    try {
      for (const [userId, user] of store.users()) {
        try {
          const { alarms, key, mockData } = await planFor(user, provider, now(), { windowMin, subway });
          if (!alarms.length) continue;
          if (mockData && pushWhenMock === 'skip') { stats.skippedMock += alarms.length; continue; }
          const main = alarms.find((a) => a.type === 'depart') || alarms.find((a) => a.type === 'earlier') || alarms[0];
          const tone = alarms.reduce((t, a) => ((SEVERITY[a.tone] || 0) > (SEVERITY[t] || 0) ? a.tone : t), main.tone);
          const body = mockData ? `${main.body}${MOCK_NOTE}` : main.body;
          const r = await sendAndLog(store, userId, pusher, user.push, { title: main.title, body, tag: `${key}:${main.type}`, level: tone, url: '/', source: mockData ? 'mock' : 'seoul' }, { kind: 'alarm', now: now().getTime() });
          store.update(userId, (u) => {
            const rec = u.fired[key] || (u.fired[key] = {});
            for (const a of alarms) { if (a.type === 'earlier') rec.depart = { departMin: a.departMin }; else rec[a.type] = { departMin: a.departMin }; }
          });
          sent.push({ userId, types: alarms.map((a) => a.type), title: main.title, body, source: mockData ? 'mock' : 'seoul', delivered: r?.sent ?? 0 });
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
