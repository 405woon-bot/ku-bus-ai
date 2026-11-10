// 시간 유틸리티 — 프론트엔드·백엔드 공용(순수 함수)
export const DAYS = ['월', '화', '수', '목', '금'];
export const pad2 = (n) => String(n).padStart(2, '0');

/** "09:05" → 545(자정부터 분). 형식이 틀리면 NaN */
export function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return NaN;
  const h = +m[1], mm = +m[2];
  return h < 24 && mm < 60 ? h * 60 + mm : NaN;
}
const norm = (min) => ((Math.round(min) % 1440) + 1440) % 1440;
/** 545 → "09:05" (화면 표시용) */
export const toHHMM = (min) => { const v = norm(min); return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`; };
/** 545 → "9:05" (알림 문장용) */
export const toHMM = (min) => { const v = norm(min); return `${Math.floor(v / 60)}:${pad2(v % 60)}`; };

/**
 * 서울 시각 기준 요일·분·날짜 키. 서버 시간대가 UTC여도 정확합니다.
 * @returns {{ weekday: number, minutes: number, dateKey: string }} weekday 0=월 … 6=일
 */
export function seoulParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday];
  const hour = p.hour === '24' ? 0 : +p.hour;
  return { weekday, minutes: hour * 60 + +p.minute + +p.second / 60, dateKey: `${p.year}-${p.month}-${p.day}` };
}
