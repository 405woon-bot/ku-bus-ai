import { useEffect, useRef, useState } from 'react';
import { seoulParts, toMin } from '@shared/time.js';

/**
 * 현재 시각(서울 기준). 데모 모드면 지정한 요일·시각에서 speed 배속으로 흐릅니다.
 * @returns {{ weekday:number, minutes:number, dateKey:string, isDemo:boolean }}
 */
export function useNow(demo) {
  const [, setTick] = useState(0);
  const base = useRef(null);
  const sig = `${demo.enabled}|${demo.weekday}|${demo.time}|${demo.speed}|${demo.epoch}`;
  if (!base.current || base.current.sig !== sig) base.current = { sig, t0: Date.now() };
  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 500); return () => clearInterval(id); }, []);
  if (!demo.enabled) return { ...seoulParts(new Date()), isDemo: false };
  let minutes = toMin(demo.time) + ((Date.now() - base.current.t0) / 60000) * demo.speed, weekday = demo.weekday;
  while (minutes >= 1440) { minutes -= 1440; weekday = (weekday + 1) % 7; }
  return { weekday, minutes, dateKey: `demo${demo.epoch}-${weekday}`, isDemo: true };
}
