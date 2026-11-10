// 시간표 캡처 이미지(에브리타임 등) → 수업 블록 후보.
// OCR 없이도 동작하는 부분: 격자선(연회색 가로·세로줄)으로 요일 열·시간 간격을 찾고,
// 색이 있는 사각 블록을 연결 성분으로 묶어 위치 → 요일·시작·종료 시각으로 바꿉니다.
// 과목명·강의실 글자는 ocr.js(Tesseract.js)로 읽거나 사용자가 입력합니다.

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 열 수 없어요. PNG나 JPG 파일인지 확인하세요.'));
    img.src = src;
  });
}

/** 처리 속도를 위해 폭 maxW 이하로 줄인 캔버스 */
export function imageToCanvas(img, maxW = 720) {
  const s = Math.min(1, maxW / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
  return c;
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function groupLines(counts, min) {
  const lines = []; let run = null;
  counts.forEach((c, i) => {
    if (c >= min) { if (run) run.b = i; else run = { a: i, b: i }; }
    else if (run) { lines.push((run.a + run.b) / 2); run = null; }
  });
  if (run) lines.push((run.a + run.b) / 2);
  return lines;
}
/** 간격이 거의 같은 줄이 가장 길게 이어진 구간 */
function longestEvenRun(lines, tol = 0.12) {
  if (lines.length < 2) return { run: lines, gap: 0 };
  const gaps = lines.slice(1).map((v, i) => v - lines[i]).filter((g) => g > 6);
  const gap = median(gaps);
  let best = [lines[0]], cur = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i] - lines[i - 1];
    if (Math.abs(g - gap) <= gap * tol) cur.push(lines[i]); else cur = [lines[i]];
    if (cur.length > best.length) best = [...cur];
  }
  return { run: best, gap };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ grid: {left,right,top,hourH,colW,days}, blocks: Array<{x,y,w,h,rgb}>, found: {hLines:number, vLines:number} }}
 */
export function detectTimetable(canvas, { days = 5 } = {}) {
  const W = canvas.width, H = canvas.height;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const colored = new Uint8Array(W * H), rowGray = new Array(H).fill(0), colGray = new Array(W).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 110 && (mx - mn) / mx > 0.16) colored[y * W + x] = 1;
    else if (mx - mn < 14 && mx >= 190 && mx <= 243) { rowGray[y]++; colGray[x]++; }
  }
  // 격자선: 연회색 픽셀이 한 줄의 35% 이상(블록에 가려진 부분 고려)
  const hLines = groupLines(rowGray, W * 0.35), vLines = groupLines(colGray, H * 0.35);
  const h = longestEvenRun(hLines), v = longestEvenRun(vLines);
  let colW = v.gap, left, right;
  if (v.run.length >= days) {
    left = v.run[0]; right = v.run.length > days ? v.run[days] : left + days * colW;
  } else { left = Math.round(W * 0.07); right = W; colW = (right - left) / days; }
  const hourH = h.gap || H / 10, top = h.run.length ? h.run[0] : Math.round(H * 0.06);

  // 색 블록: 비슷한 색끼리 4방향 연결
  const seen = new Uint8Array(W * H), blocks = [];
  const minArea = Math.max(80, colW * hourH * 0.12);
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const p = y * W + x;
    if (!colored[p] || seen[p]) continue;
    const sr = data[p * 4], sg = data[p * 4 + 1], sb = data[p * 4 + 2];
    let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
    const stack = [p]; seen[p] = 1;
    while (stack.length) {
      const q = stack.pop(), qx = q % W, qy = (q / W) | 0; n++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      for (const nq of [q + 1, q - 1, q + W, q - W]) {
        if (nq < 0 || nq >= W * H || seen[nq] || !colored[nq]) continue;
        if ((nq === q + 1 && qx === W - 1) || (nq === q - 1 && qx === 0)) continue;
        const j = nq * 4;
        if (Math.abs(data[j] - sr) + Math.abs(data[j + 1] - sg) + Math.abs(data[j + 2] - sb) > 70) continue;
        seen[nq] = 1; stack.push(nq);
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (n >= minArea && bw >= colW * 0.45 && bh >= hourH * 0.2 && x0 >= left - 4) blocks.push({ x: x0, y: y0, w: bw, h: bh, rgb: [sr, sg, sb] });
  }
  blocks.sort((a, b) => a.x - b.x || a.y - b.y);
  return { grid: { left, right, top, hourH, colW, days }, blocks, found: { hLines: h.run.length, vLines: v.run.length } };
}

/** 블록 위치 → 요일(0=월)·시각(5분 단위). startHour: 첫 가로줄이 가리키는 시각 */
export function blocksToClasses(blocks, grid, startHour = 9) {
  const r5 = (m) => Math.round(m / 5) * 5;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return blocks.map((b, i) => {
    const day = Math.max(0, Math.min(grid.days - 1, Math.floor((b.x + b.w / 2 - grid.left) / grid.colW)));
    const s = r5(startHour * 60 + ((b.y - grid.top) / grid.hourH) * 60);
    const e = r5(startHour * 60 + ((b.y + b.h - grid.top) / grid.hourH) * 60);
    return { key: i, day, start: hhmm(s), end: hhmm(Math.max(e, s + 15)), box: b };
  });
}

/** OCR용으로 블록 영역을 2배 확대해 잘라낸 캔버스 */
export function cropBlock(canvas, b, pad = 2) {
  const c = document.createElement('canvas'), k = 2;
  c.width = (b.w + pad * 2) * k; c.height = (b.h + pad * 2) * k;
  c.getContext('2d').drawImage(canvas, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, 0, 0, c.width, c.height);
  return c;
}
