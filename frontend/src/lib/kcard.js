// K•CARD+ 캡처 이미지: 이 기기(브라우저)에만 저장합니다 — 서버(Upstash)로 보내지 않아요. 이 파일에는 네트워크 요청이 없습니다.
//   1순위 IndexedDB: 원본 그대로(작은 캡처) · 큰 사진은 긴 변 2600px JPEG(0.92)로 줄임 — QR이 뭉개지지 않게 넉넉히
//   2순위 localStorage: IndexedDB를 못 쓰는 브라우저(일부 개인 정보 보호 모드 등)면 긴 변 1200px JPEG(0.85)로 압축
//   3순위 메모리: 둘 다 막힌 환경(미리보기 창 등) — 새로 고치면 지워짐(화면에 알림)
const DB_NAME = 'kubusai', STORE = 'files', KEY = 'kcard', LS_KEY = 'kubusai:kcard';
export const KCARD_LIMITS = Object.freeze({ maxFileBytes: 20 * 1024 * 1024, maxDim: 2600, keepBytes: 3 * 1024 * 1024, lsMaxDim: 1200 });
let memory = null; // 3순위(이 창에서만)

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, reject) => { setTimeout(() => reject(new Error(msg)), ms); })]);

function openDb() {
  return withTimeout(new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB를 열지 못했어요'));
    req.onblocked = () => reject(new Error('IndexedDB가 막혀 있어요'));
  }), 3000, 'IndexedDB 응답이 없어요');
}
async function idb(mode, run) {
  if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB 없음');
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode), r = run(tx.objectStore(STORE));
      let out;
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 오류'));
      tx.onabort = () => reject(tx.error || new Error('저장 공간이 부족해요'));
    });
  } finally { db.close(); }
}

const readBuffer = (blob) => (typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer()
  : new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsArrayBuffer(blob); }));
const readDataUrl = (blob) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsDataURL(blob); });

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽지 못했어요. PNG · JPG 캡처를 골라 주세요')); };
    img.src = url;
  });
}
function shrink(img, maxDim, quality) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, s = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // 투명한 PNG가 검게 되지 않게
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve({ blob: b, width: c.width, height: c.height, type: 'image/jpeg' }) : reject(new Error('이미지를 줄이지 못했어요'))), 'image/jpeg', quality));
}

/** 고른 파일 → 저장할 이미지(작은 캡처는 원본 그대로, 크면 줄여서) */
export async function prepareImage(file) {
  const type = String(file?.type || '');
  if (!file || (!type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name || ''))) throw new Error('이미지 파일(PNG · JPG)을 골라 주세요');
  if (file.size > KCARD_LIMITS.maxFileBytes) throw new Error('파일이 너무 커요(20MB까지)');
  const img = await loadImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error('이미지를 읽지 못했어요');
  if (/^image\/(png|jpeg|webp)$/.test(type) && file.size <= KCARD_LIMITS.keepBytes && Math.max(w, h) <= KCARD_LIMITS.maxDim) return { blob: file, width: w, height: h, type };
  return shrink(img, KCARD_LIMITS.maxDim, 0.92);
}

const metaOf = (r, where) => ({ width: r.width, height: r.height, size: r.size, type: r.type, savedAt: r.savedAt, where });

/** 저장(이전 이미지는 바뀜) → { url, meta:{ width, height, size, type, savedAt, where:'idb'|'local'|'memory' } } */
export async function saveKCard(file) {
  const img = await prepareImage(file);
  const base = { width: img.width, height: img.height, size: img.blob.size, type: img.type, savedAt: Date.now() };
  try {
    const buf = await readBuffer(img.blob); // 아이폰 예전 버전도 되게 Blob 대신 ArrayBuffer로
    await idb('readwrite', (st) => st.put({ ...base, buf }, KEY));
    try { localStorage.removeItem(LS_KEY); } catch { /* 없음 */ }
    memory = null;
    try { navigator.storage?.persist?.().catch(() => {}); } catch { /* 지원 안 함 */ } // 브라우저가 공간 정리할 때 지우지 않게(가능하면)
    return { url: URL.createObjectURL(new Blob([buf], { type: img.type })), meta: metaOf(base, 'idb') };
  } catch { /* IndexedDB를 못 씀 → 줄여서 localStorage */ }
  const small = await shrink(await loadImage(img.blob), KCARD_LIMITS.lsMaxDim, 0.85);
  const dataUrl = await readDataUrl(small.blob);
  const rec = { width: small.width, height: small.height, size: small.blob.size, type: small.type, savedAt: base.savedAt };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...rec, dataUrl }));
    memory = null;
    return { url: dataUrl, meta: metaOf(rec, 'local') };
  } catch {
    memory = { ...rec, dataUrl };
    return { url: dataUrl, meta: metaOf(rec, 'memory') };
  }
}

/** 저장된 이미지 → { url, meta } 또는 null */
export async function loadKCard() {
  try {
    const r = await idb('readonly', (st) => st.get(KEY));
    if (r?.buf) return { url: URL.createObjectURL(new Blob([r.buf], { type: r.type || 'image/png' })), meta: metaOf(r, 'idb') };
  } catch { /* IndexedDB를 못 쓰면 다음 */ }
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (j?.dataUrl) return { url: j.dataUrl, meta: metaOf(j, 'local') };
  } catch { /* 없음 */ }
  return memory ? { url: memory.dataUrl, meta: metaOf(memory, 'memory') } : null;
}

export async function deleteKCard() {
  try { await idb('readwrite', (st) => st.delete(KEY)); } catch { /* 없음 */ }
  try { localStorage.removeItem(LS_KEY); } catch { /* 없음 */ }
  memory = null;
}

/** (미리보기 전용) 예시 이미지 — 실제 학생증 모양을 흉내 내지 않은 일반 그림 */
export function sampleCardFile() {
  const c = document.createElement('canvas'); c.width = 780; c.height = 1560;
  const g = c.getContext('2d');
  const box = (x, y, w, h, r, fill) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fillStyle = fill; g.fill(); };
  g.fillStyle = '#EEF1F5'; g.fillRect(0, 0, c.width, c.height);
  g.setLineDash([18, 12]); g.lineWidth = 6; g.strokeStyle = '#8A94A6'; g.strokeRect(40, 70, 700, 150); g.setLineDash([]);
  g.fillStyle = '#4B5565'; g.textAlign = 'center'; g.font = 'bold 58px sans-serif'; g.fillText('예시 이미지', 390, 160);
  g.font = '34px sans-serif'; g.fillText('실제 학생증이 아니에요', 390, 205);
  box(70, 290, 640, 1080, 44, '#FFFFFF');
  g.fillStyle = '#C9D1DC'; g.beginPath(); g.arc(390, 470, 96, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(390, 680, 150, Math.PI, 0); g.fill();
  g.fillStyle = '#1F2633'; g.font = 'bold 50px sans-serif'; g.fillText('이름 예시', 390, 790);
  g.fillStyle = '#6B7585'; g.font = '36px sans-serif'; g.fillText('학번 0000000', 390, 845);
  // 무늬(코드 아님): 가운데 정사각형 칸
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const n = 21, cell = 18, x0 = 390 - (n * cell) / 2, y0 = 900;
  g.fillStyle = '#F4F6F9'; g.fillRect(x0 - 20, y0 - 20, n * cell + 40, n * cell + 40);
  g.fillStyle = '#2B3442';
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (rnd() > 0.55) g.fillRect(x0 + i * cell, y0 + j * cell, cell, cell);
  g.fillStyle = '#206DEF'; g.font = 'bold 30px sans-serif'; g.fillText('KU BUS AI 미리보기용 그림', 390, 1340);
  return new Promise((resolve) => c.toBlob((b) => resolve(new File([b], 'kcard-example.png', { type: 'image/png' })), 'image/png'));
}
