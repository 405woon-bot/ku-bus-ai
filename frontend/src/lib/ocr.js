// 선택 기능: Tesseract.js(한국어)로 블록 안 글자 읽기.
// 실행 시점에 CDN 스크립트를 불러옵니다. 언어 데이터(kor.traineddata)를 내려받아야 하므로
// 외부 요청이 막힌 환경(일부 미리보기)에서는 실패하며, 그때는 사용자가 과목명을 입력합니다.
// 자체 배포 시에는 npm i tesseract.js 후 workerPath/langPath를 자체 서버 경로로 지정하는 것을 권장합니다.
import { cropBlock } from './detectTimetableImage.js';
import { BUILDINGS } from '@shared/campusData.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

function loadScript(src, timeoutMs = 15000) {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const t = setTimeout(() => reject(new Error('OCR 엔진을 불러오는 데 시간이 너무 오래 걸려요')), timeoutMs);
    s.src = src; s.async = true;
    s.onload = () => { clearTimeout(t); window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR 엔진을 찾지 못했어요')); };
    s.onerror = () => { clearTimeout(t); reject(new Error('OCR 엔진을 불러오지 못했어요(네트워크 차단)')); };
    document.head.appendChild(s);
  });
}
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

/** 블록 글자 → { name, building, room } 추정 */
export function interpretOcrText(text) {
  const lines = String(text || '').split('\n').map((s) => s.replace(/[|_~`]/g, '').trim()).filter((s) => s.length > 1);
  let building = '', room = '';
  for (const l of lines) for (const b of BUILDINGS) {
    if (l.replace(/\s/g, '').includes(b.name.replace(/\s/g, ''))) { building = b.name; const m = l.match(/([A-Za-z]?\d{2,4}[A-Za-z]?)/); if (m) room = m[1]; }
  }
  const name = (lines.find((l) => !BUILDINGS.some((b) => l.includes(b.name))) || '').replace(/\s+/g, ' ');
  return { name, building, room };
}

/** @returns {Promise<Array<{name,building,room}>>} blocks 순서와 같은 결과 */
export async function ocrBlocks(canvas, blocks, onProgress) {
  const T = await loadScript(TESSERACT_URL);
  const worker = await withTimeout(T.createWorker('kor+eng'), 30000, 'OCR 언어 데이터를 내려받지 못했어요(네트워크 차단 또는 지연)');
  try {
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      onProgress?.(i + 1, blocks.length);
      const { data } = await worker.recognize(cropBlock(canvas, blocks[i]));
      out.push(interpretOcrText(data.text));
    }
    return out;
  } finally { await worker.terminate(); }
}
