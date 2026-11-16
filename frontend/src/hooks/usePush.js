import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { disablePush, enablePush, syncSubscription } from '../lib/push.js';

const POLL_MS = 3000, POLL_FOR_MS = 60000;

function startState(sample, info) {
  if (info.needsInstall) return 'need-install';
  if (sample) return 'off';
  if (!info.pushApi) return 'unsupported';
  return 'checking';
}

/**
 * 백그라운드 알림(Web Push) 상태
 * - 앱을 열 때마다: 서비스 워커 등록 → 권한이 있으면 이 기기 구독을 서버와 맞춤(없어졌거나 서버가 모르면 자동 재등록)
 * - 알림 켜기(버튼) · 테스트 알림 → 휴대폰 서비스 워커가 '받았음'을 알리면 수신 확인됨(그 전까지 '확인 필요')
 * - 미리보기(sample)는 서버가 없어 같은 흐름을 예시로만 보여 줌(실제 알림 아님)
 * state: checking · unsupported · need-install · off · denied · needs-tap · no-vapid · on · error
 */
export function usePush({ mode, info }) {
  const sample = mode !== 'api';
  const [st, setSt] = useState(() => ({ state: startState(sample, info), busy: false, push: null, endpoint: null, renewedAt: null, testSentAt: null, pollDone: false, error: null }));
  const key = useRef(null);
  const set = useCallback((patch) => setSt((s) => ({ ...s, ...patch })), []);
  const apply = useCallback((r) => setSt((s) => ({
    ...s, state: r.state, endpoint: r.endpoint ?? (r.state === 'on' ? s.endpoint : null), push: r.push ?? (r.state === 'on' ? s.push : null),
    error: r.error ?? null, renewedAt: r.renewed ? Date.now() : s.renewedAt,
  })), []);

  // 앱을 열 때(기기가 바뀔 때) 자동 확인
  useEffect(() => {
    if (sample || info.needsInstall || !info.pushApi) {
      setSt((s) => ({ ...s, state: startState(sample, info), push: null, endpoint: null, testSentAt: null, error: null }));
      return undefined;
    }
    let alive = true;
    (async () => {
      try {
        key.current = await api.pushKey();
        const r = await syncSubscription({ interactive: false, info, key: key.current });
        if (alive) apply(r);
      } catch (e) { if (alive) set({ state: 'error', error: e.message }); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, info.label, info.standalone, info.needsInstall, info.pushApi]);

  const latest = useRef(st);
  latest.current = st;
  // 서버의 수신 확인 · 구독 상태 다시 보기. 서버가 이 기기 구독을 모르면(서버 기록이 지워짐 등) 바로 자동 재등록
  const refresh = useCallback(async () => {
    const s = latest.current;
    if (sample || s.state !== 'on' || !s.endpoint) return;
    try {
      const r = await api.pushStatus(s.endpoint);
      if (r.known) setSt((x) => ({ ...x, push: r }));
      else apply(await syncSubscription({ interactive: false, info, key: key.current || undefined }));
    } catch { /* 다음 확인 때 */ }
  }, [sample, apply, info]);

  // 테스트 알림을 보낸 뒤: 3초마다(최대 1분) · 앱으로 돌아올 때 수신 확인을 다시 봄
  useEffect(() => {
    if (sample || !st.testSentAt) return undefined;
    const started = st.testSentAt;
    const id = setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) { clearInterval(id); set({ pollDone: true }); return; }
      refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [sample, st.testSentAt, refresh, set]);
  useEffect(() => {
    if (sample) return undefined;
    const on = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [sample, refresh]);

  const enable = async () => {
    if (sample) {
      set({ busy: true });
      setTimeout(() => setSt((s) => ({ ...s, busy: false, state: 'on', push: { device: { ackAt: null, seenAt: new Date().toISOString() }, lastTest: null, lastAlarm: null } })), 500);
      return;
    }
    set({ busy: true, error: null }); // 아래 enablePush가 곧바로 권한을 물음(버튼을 누른 순간)
    try { apply(await enablePush({ info, key: key.current })); } catch (e) { set({ state: 'error', error: e.message }); } finally { set({ busy: false }); }
  };
  const test = async () => {
    if (sample) {
      const t = Date.now();
      set({ testSentAt: t, pollDone: false, error: null });
      setTimeout(() => setSt((s) => {
        const ack = new Date().toISOString();
        return { ...s, push: { ...(s.push || {}), device: { ...(s.push?.device || {}), ackAt: ack }, lastTest: { sentAt: new Date(t).toISOString(), ackAt: ack } } };
      }), 1800);
      return;
    }
    set({ busy: true, error: null });
    try {
      const r = await api.pushTest(st.endpoint);
      set({ busy: false, testSentAt: Date.now(), pollDone: false, push: r.push || st.push });
    } catch (e) {
      set({ busy: false, error: e.message, ...(e.kind === 'no-subscription' ? { state: 'needs-tap' } : {}) });
    }
  };
  const disable = async () => {
    if (!sample) { set({ busy: true }); await disablePush().catch(() => {}); }
    setSt((s) => ({ ...s, busy: false, state: 'off', push: null, endpoint: null, testSentAt: null, error: null }));
  };

  const confirmedAt = st.push?.device?.ackAt || null;
  return { ...st, sample, confirmedAt, enable, test, disable, refresh };
}
