// 홈 화면 앱으로 설정 이어받기.
//   아이폰 홈 화면 앱은 Safari와 저장 공간이 따로라, 그냥 두면 정류장 · 시간표를 처음부터 다시 넣어야 합니다.
//   Safari에서 열려 있는 동안 주소에 한 번만 쓰는 코드(?h=…, 2시간)를 붙여 두고, 홈 화면 앱(또는 새 브라우저)이
//   처음 열릴 때 그 코드로 같은 사용자 ID를 받아 옵니다. 이미 이 기기에 사용자가 있으면 코드는 무시합니다.
import { api, hasLocalUserId, setUserId } from './api.js';

const TOKEN = /^[\w-]{8,40}$/;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** 주소에서 코드를 떼어 내고(주소창에 남기지 않음), 처음 여는 기기면 같은 사용자로 이어 받음 */
export async function bootstrapIdentity() {
  let token = null;
  try {
    const url = new URL(window.location.href);
    token = url.searchParams.get('h');
    if (token !== null) { url.searchParams.delete('h'); window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash); }
  } catch { return {}; }
  if (!token || !TOKEN.test(token) || hasLocalUserId()) return {};
  try {
    const r = await withTimeout(api.claimHandoff(token), 6000);
    // v2.2.2 받은 ID가 'demo'(예전에 저장 공간이 막힌 기기들이 같이 쓰던 값)면 받지 않고 새 사용자로 시작
    if (r?.userId && setUserId(r.userId)) return { claimed: true, hasData: Boolean(r.hasData) };
  } catch { /* 시간이 지났거나 이미 쓴 코드 → 새 사용자로 시작 */ }
  return {};
}

/** Safari(설치 전)에서: 주소에 이어받기 코드를 붙여 둠 — 이 주소 그대로 홈 화면에 추가됨 */
export async function attachHandoffToUrl() {
  const { token } = await api.handoff();
  if (!TOKEN.test(token || '')) return null;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('h', token);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch { /* 주소를 바꿀 수 없는 환경 */ }
  return token;
}
