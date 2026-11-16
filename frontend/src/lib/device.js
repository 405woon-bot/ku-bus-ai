// 기기 · 브라우저 구분. 아이폰은 '홈 화면에 추가한 앱'에서만 웹 푸시가 되므로(iOS 16.4 이상) 안내를 달리합니다.
//   - iOS 26부터 Safari는 주소창 옆 ⋯ → 공유 → 홈 화면에 추가, 그 전에는 아래쪽 공유 버튼 → 홈 화면에 추가
//   - 카카오톡 · 인스타그램 등 앱 안의 브라우저는 홈 화면에 추가할 수 없어 Safari로 열도록 안내

const IN_APP = [
  [/KAKAOTALK/i, '카카오톡'], [/NAVER\(inapp|NAVER\//i, '네이버 앱'], [/Instagram/i, '인스타그램'], [/FBAN|FBAV|FB_IAB/i, '페이스북'],
  [/\bLine\//i, '라인'], [/DaumApps/i, '다음 앱'], [/everytime/i, '에브리타임'], [/BAND\//i, '밴드'], [/Whale\/.*Mobile.*inapp/i, '웨일'],
];

/**
 * @param {{ ua?: string, maxTouchPoints?: number, standalone?: boolean, pushApi?: boolean }} [o] 테스트 · 미리보기에서 바꿔 끼움
 * @returns {{ ios, iPad, android, browser: 'safari'|'other'|'inapp'|'default', inAppName, standalone, safariMajor, newShare, pushApi, needsInstall, label }}
 */
export function deviceInfo(o = {}) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const win = typeof window !== 'undefined' ? window : {};
  const ua = o.ua ?? nav.userAgent ?? '';
  const iPadOS = /Macintosh/.test(ua) && (o.maxTouchPoints ?? nav.maxTouchPoints ?? 0) > 1;
  const iPad = /iPad/.test(ua) || iPadOS;
  const ios = /iPhone|iPod/.test(ua) || iPad;
  const android = /Android/i.test(ua);
  let standalone = o.standalone;
  if (standalone === undefined) {
    try { standalone = nav.standalone === true || Boolean(win.matchMedia?.('(display-mode: standalone)')?.matches); } catch { standalone = false; }
  }
  const inApp = IN_APP.find(([re]) => re.test(ua));
  // iOS 앱 안의 브라우저(WKWebView)는 보통 UA에 'Safari/'가 없음
  const browser = inApp || (ios && !/Safari\//.test(ua) && !standalone) ? 'inapp'
    : ios && /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|Whale/i.test(ua) ? 'other' : ios ? 'safari' : 'default';
  const safariMajor = Number((/Version\/(\d+)/.exec(ua) || [])[1]) || null;
  let pushApi = o.pushApi;
  if (pushApi === undefined) { try { pushApi = 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win; } catch { pushApi = false; } }
  return {
    ios, iPad, android, browser, inAppName: inApp ? inApp[1] : null, standalone: Boolean(standalone), safariMajor,
    newShare: (safariMajor ?? 0) >= 26, // iOS 26 Safari: ⋯ → 공유
    pushApi: Boolean(pushApi),
    needsInstall: ios && !standalone, // 아이폰 · 아이패드는 홈 화면 앱에서만 웹 푸시
    label: iPad ? 'iPad' : ios ? 'iPhone' : android ? 'Android' : 'PC',
  };
}

/** 미리보기 '기기 보기' 단추로 고른 가상 기기(실제 기기 판별은 하지 않음) */
export function previewDevice(kind) {
  const base = { ios: false, iPad: false, android: false, browser: 'default', inAppName: null, standalone: false, safariMajor: null, newShare: false, pushApi: true, needsInstall: false, label: 'PC' };
  if (kind === 'safari') return { ...base, ios: true, browser: 'safari', safariMajor: 26, newShare: true, needsInstall: true, label: 'iPhone' };
  if (kind === 'app') return { ...base, ios: true, browser: 'safari', safariMajor: 26, newShare: true, standalone: true, label: 'iPhone' };
  if (kind === 'inapp') return { ...base, ios: true, browser: 'inapp', inAppName: '카카오톡', needsInstall: true, label: 'iPhone' };
  return base;
}
