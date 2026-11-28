// 1분마다 사용자의 오늘 추천을 다시 계산해, 보낼 알림이 있으면 Web Push로 보내고 기록합니다.
// - 실시간 조회는 첫 수업 3시간 전부터 수업 시작까지만(서울시 API 호출 절약). 같은 정류장은 캐시를 거쳐 한 번만 호출.
// - 동시에 걸린 알림(예: 출발 10분 전 + 빠듯)은 화면처럼 하나로 합쳐 보냅니다.
// - 예시(모의) 데이터로 계산된 알림은 본문에 출처를 밝힙니다(PUSH_WHEN_MOCK=skip이면 보내지 않음).
// - 보낼 때마다 수신 확인 번호를 실어 보내고 기록(pushLog) — 휴대폰 서비스 워커가 '받았음'을 알리면 설정 화면에 '수신 확인됨'
// - Render 무료 서버는 15분 동안 접속이 없으면 잠들어 이 1분 타이머도 멈춥니다 → cron-job.org가 /api/wake로 깨워 둠(README)
// - v2.1: 같은 타이머로 밤에 주요 환승역 경로를 미리 찾아 둠(warmer.step — 시간 · 남은 한도를 스스로 확인)
// - v2.8.0 기록마다 위에서부터 먼저 맞는 줄로(승인한 설계안 그대로):
//     ① 알림 구독이 없음 → 건너뜀(실시간 호출 · 계산 없음 — 알림을 보낼 곳이 없어 결과는 예전과 같음)
//     ② 설정 › 출발 알림 꺼짐 → 건너뜀
//     ③ 앱을 SCHEDULER_SLEEP_DAYS(7)일 동안 열지 않음 → 쉼(sleep.js) — 쉬기 시작할 때 낮에 안내 알림 한 번 · 앱을 열면 다음 1분부터 다시
//     ④ 나머지만 계산(planned)
import { planFor } from './planner.js';
import { sendAndLog } from './push.js';

export const MOCK_NOTE = ' (예시 교통 데이터 기준 · 실시간 아님)';
const SEVERITY = { danger: 2, warn: 1 };
const zeroUsers = () => ({ total: 0, planned: 0, noPush: 0, notifyOff: 0, asleep: 0 });

export function createScheduler({ store, provider, pusher, now = () => new Date(), intervalMs = 60000, windowMin = 180, pushWhenMock = 'label', log = console, subway = null, gyeonggi = null, warmer = null, sleep = null }) {
  let timer = null, running = false;
  const stats = { lastTickAt: null, ticks: 0, sent: 0, skippedMock: 0, lastError: null, users: null };

  /** v2.8.0 쉬기 안내 알림(교통 API는 부르지 않음) — 실패해도 다음 기록 계산은 계속 */
  async function sleepNotice(userId, user, t) {
    const { title, body } = sleep.text();
    const r = await sendAndLog(store, userId, pusher, user.push, { title, body, tag: 'kubus-sleep', level: 'info', url: '/', source: 'server' }, { kind: 'sleep', now: t });
    sleep.noted(userId, { at: t, sent: r?.sent ?? 0 });
  }

  async function tick() {
    // v2.1 밤에 주요 환승역 경로 미리 찾기(정해진 시간 · 남은 한도일 때만 한 곳) — 알림 계산을 기다리게 하지 않음
    if (warmer) warmer.step(now()).catch(() => {});
    if (running) return [];
    running = true;
    const sent = [];
    const users = zeroUsers();
    try {
      for (const [userId, user] of store.users()) {
        users.total++;
        // v2.8.0 ① · ② 알림을 보낼 곳이 없거나 출발 알림을 껐으면 계산하지 않음
        if (!user?.push?.length) { users.noPush++; continue; }
        if (user.prefs?.notify === false) { users.notifyOff++; continue; }
        try {
          // v2.8.0 ③ 앱을 오래 열지 않은 기록은 쉼(쉬기 시작할 때 낮에 안내 알림 한 번)
          const t = now().getTime();
          if (sleep?.asleep(user, t)) {
            users.asleep++;
            if (sleep.noticeDue(user, t)) await sleepNotice(userId, user, t);
            continue;
          }
          users.planned++;
          const { alarms, key, mockData } = await planFor(user, provider, now(), { windowMin, subway, gyeonggi });
          if (!alarms.length) continue;
          if (store.peek && store.peek(userId) === undefined) continue; // v2.2.4 계산하는 사이 지워진 사용자(90일 자동 삭제)
          if (mockData && pushWhenMock === 'skip') { stats.skippedMock += alarms.length; continue; }
          const main = alarms.find((a) => a.type === 'depart') || alarms.find((a) => a.type === 'earlier') || alarms[0];
          const tone = alarms.reduce((tn, a) => ((SEVERITY[a.tone] || 0) > (SEVERITY[tn] || 0) ? a.tone : tn), main.tone);
          const body = mockData ? `${main.body}${MOCK_NOTE}` : main.body;
          const r = await sendAndLog(store, userId, pusher, user.push, { title: main.title, body, tag: `${key}:${main.type}`, level: tone, url: '/', source: mockData ? 'mock' : 'seoul' }, { kind: 'alarm', now: now().getTime() });
          if (store.peek && store.peek(userId) === undefined) continue; // v2.2.4 보내는 사이 지워짐 → 기록을 다시 만들지 않음
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
      stats.users = users;
    }
    return sent;
  }
  return {
    tick,
    // v2.8.0 users: 마지막 1분에 본 기록 수(전체 · 계산 · 알림 구독 없음 · 출발 알림 꺼짐 · 쉼) · sleep: 쉬기 설정 · 안내 알림 수 — 개수만
    status: () => ({ running: Boolean(timer), intervalSec: intervalMs / 1000, windowMin, pushWhenMock, ...stats, users: stats.users ? { ...stats.users } : null, sleep: sleep?.health?.() ?? null }),
    start() { if (!timer) { timer = setInterval(tick, intervalMs); tick(); } return this; },
    stop() { clearInterval(timer); timer = null; },
  };
}
