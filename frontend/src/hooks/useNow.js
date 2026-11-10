import { useEffect, useRef, useState } from 'react';
import { seoulParts } from '@shared/time.js';
import { SAMPLE_START_MIN, SAMPLE_WEEKDAY } from '@source';

/**
 * 현재 시각(서울). 실서비스는 실제 시각, 미리보기는 샘플 응답 시각(월 08:05)부터 speed배로 흐릅니다.
 * @returns {{ weekday, minutes, dateKey, isSample, elapsedSec }}
 */
export function useNow(mode, preview) {
  const [, setTick] = useState(0);
  const base = useRef(null);
  const sig = `${preview.epoch}`;
  if (!base.current || base.current.sig !== sig) base.current = { sig, t0: Date.now(), acc: 0, speed: preview.speed, last: Date.now() };
  // 배속을 바꿔도 시각이 튀지 않게 누적
  if (base.current.speed !== preview.speed) { const b = base.current; b.acc += ((Date.now() - b.last) / 1000) * b.speed; b.last = Date.now(); b.speed = preview.speed; }
  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  if (mode !== 'sample') return { ...seoulParts(new Date()), isSample: false };
  const b = base.current, elapsedSec = b.acc + ((Date.now() - b.last) / 1000) * b.speed;
  let minutes = SAMPLE_START_MIN + elapsedSec / 60, weekday = SAMPLE_WEEKDAY;
  while (minutes >= 1440) { minutes -= 1440; weekday = (weekday + 1) % 7; }
  return { weekday, minutes, dateKey: `sample${preview.epoch}-${weekday}`, isSample: true, elapsedSec };
}
