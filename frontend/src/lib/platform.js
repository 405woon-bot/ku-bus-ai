// 브라우저 기능 래퍼: 저장소·알림. 모두 실패해도 앱이 멈추지 않게 try/catch로 감쌉니다.
const KEY = 'kubusai:v1';
export function loadState() { try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
export function saveState(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } }
export function clearState() { try { localStorage.removeItem(KEY); } catch { /* 무시 */ } }

/** 알림 권한 상태: granted | denied | default | unsupported */
export function notifyPermission() {
  try { return 'Notification' in window ? Notification.permission : 'unsupported'; } catch { return 'unsupported'; }
}
export async function requestNotifyPermission() {
  try { return 'Notification' in window ? await Notification.requestPermission() : 'unsupported'; } catch { return 'denied'; }
}
/**
 * 시스템 알림 표시. 서비스 워커가 있으면 그쪽으로(모바일 크롬은 new Notification을 막음).
 * @returns {Promise<boolean>} 시스템 알림을 띄웠는지
 */
export async function showSystemNotification({ title, body, tag }) {
  if (notifyPermission() !== 'granted') return false;
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg) { await reg.showNotification(title, { body, tag, renotify: true, icon: undefined }); return true; }
  } catch { /* 서비스 워커 없음 → 아래로 */ }
  try { const n = new Notification(title, { body, tag, renotify: true }); n.onclick = () => { window.focus(); n.close(); }; return true; } catch { return false; }
}
