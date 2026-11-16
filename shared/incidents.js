// 서울시 실시간 돌발정보(서울 열린데이터광장 AccInfo) 해석 · 통학 경로 매칭 — 서버와 화면(미리보기)이 같이 씁니다.
//
// 응답 필드(실제 응답에서 확인): acc_id · occr_date(YYYYMMDD) · occr_time(HHMM) · exp_clr_date · exp_clr_time(HHMMSS)
//   · acc_type(A01~A10) · acc_dtype · link_id · grs80tm_x · grs80tm_y · acc_info(설명 글) · acc_road_code
// 좌표 grs80tm_x·y = GRS80 중부원점 TM(EPSG:5181: 원점 북위 38°·동경 127°, 가산 x 200000 · y 500000, 축척 1)
//   — 샘플 1건(봉은교 구조개선공사)을 바꾸면 실제 봉은교 근처(북위 37.5157°, 동경 127.0687°)가 나와 확인했습니다.
// 시각은 서울 시각(KST)입니다.

/** 보여 줄 돌발 종류(서울시 돌발 유형 코드 AccMainCode). rank가 작을수록 먼저 보여 줌 */
export const INCIDENT_TYPES = Object.freeze({
  A01: { label: '교통사고', kind: 'accident', rank: 0 },
  A06: { label: '버스사고', kind: 'accident', rank: 0 },
  A10: { label: '집회 · 행사', kind: 'event', rank: 1 },
  A09: { label: '기상 · 재난', kind: 'weather', rank: 2 },
  A04: { label: '공사', kind: 'work', rank: 3 },
});
export const SHOWN_TYPES = Object.freeze(Object.keys(INCIDENT_TYPES));

/** '국민대 근처' 반경의 중심: 국민대학교앞(정문) 정류장 근처 */
export const KU_POINT = Object.freeze({ lat: 37.6106, lon: 126.9970 });

/** 매칭 기준: 경로 선에서 300m · 국민대에서 1km · 3시간 안에 시작하는 것까지 · 최대 5건 */
export const MATCH = Object.freeze({ routeBufferM: 300, campusRadiusM: 1000, soonMin: 180, limit: 5 });

// ── 좌표 변환(GRS80 TM 중부원점 ↔ 위경도) — Snyder, Map Projections(1987)의 횡메르카토르 식 ──
const A = 6378137, F = 1 / 298.257222101, E2 = 2 * F - F * F, EP2 = E2 / (1 - E2);
const RAD = Math.PI / 180, LAT0 = 38 * RAD, LON0 = 127 * RAD, K0 = 1, FE = 200000, FN = 500000;
const E4 = E2 * E2, E6 = E4 * E2;
function meridian(phi) {
  return A * ((1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256) * phi
    - ((3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024) * Math.sin(2 * phi)
    + ((15 * E4) / 256 + (45 * E6) / 1024) * Math.sin(4 * phi)
    - ((35 * E6) / 3072) * Math.sin(6 * phi));
}
const M0 = meridian(LAT0);

/** TM(x, y m) → { lat, lon }. 값이 없거나 0이면 null */
export function tmToLatLon(x, y) {
  const X = Number(x), Y = Number(y);
  if (!Number.isFinite(X) || !Number.isFinite(Y) || X === 0 || Y === 0) return null;
  const mu = (M0 + (Y - FN) / K0) / (A * (1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const C1 = EP2 * c * c, T1 = t * t, N1 = A / Math.sqrt(1 - E2 * s * s), R1 = (A * (1 - E2)) / (1 - E2 * s * s) ** 1.5;
  const D = (X - FE) / (N1 * K0);
  const lat = phi1 - ((N1 * t) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = LON0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return { lat: lat / RAD, lon: lon / RAD };
}

/** { lat, lon } → TM(x, y m). 예시 · 테스트 데이터를 실제 응답 형식으로 만들 때 씁니다. */
export function latLonToTm(lat, lon) {
  const phi = lat * RAD, s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = (lon * RAD - LON0) * c;
  const x = FE + K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120);
  const y = FN + K0 * (meridian(phi) - M0 + N * t * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  return { x, y };
}

// ── 시각(서울) ──
const HOUR = 3600_000, DAY = 24 * HOUR;
const digits = (v) => String(v ?? '').replace(/\D/g, '');
/** YYYYMMDD + HHMM 또는 HHMMSS(서울 시각) → epoch ms. 날짜가 없거나 이상하면 null */
export function kstMs(date, time) {
  const d = digits(date);
  if (d.length !== 8 || /^0+$/.test(d)) return null;
  let t = digits(time);
  if (t.length === 3) t = `0${t}`;
  else if (t.length === 1 || t.length === 2) t = `${t.padStart(2, '0')}00`;
  t = t.padEnd(6, '0').slice(0, 6);
  const y = +d.slice(0, 4), mo = +d.slice(4, 6), da = +d.slice(6, 8), hh = +t.slice(0, 2), mi = +t.slice(2, 4), ss = +t.slice(4, 6);
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 24 || mi > 59 || ss > 59) return null;
  return Date.UTC(y, mo - 1, da, hh - 9, mi, ss);
}
const kst = (ms) => { const d = new Date(ms + 9 * HOUR); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const p2 = (n) => String(n).padStart(2, '0');
/** 서울 시각 짧게: 같은 날 'HH:MM' · 같은 해 'M.D HH:MM' · 그 밖 'YY.M.D' */
export function fmtKst(ms, nowMs = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const a = kst(ms), n = kst(nowMs);
  if (a.y === n.y && a.mo === n.mo && a.d === n.d) return `${p2(a.h)}:${p2(a.mi)}`;
  if (a.y === n.y) return `${a.mo}.${a.d} ${p2(a.h)}:${p2(a.mi)}`;
  return `${String(a.y).slice(2)}.${a.mo}.${a.d}`;
}
/** epoch ms → 서울 날짜 'YYYYMMDD' · 시각 'HHMM' (예시 · 테스트 데이터용) */
export const kstDate = (ms) => { const a = kst(ms); return `${a.y}${p2(a.mo)}${p2(a.d)}`; };
export const kstTime = (ms) => { const a = kst(ms); return `${p2(a.h)}${p2(a.mi)}`; };
/** 그날 서울 0시(epoch ms) */
export const kstMidnight = (ms) => Math.floor((ms + 9 * HOUR) / DAY) * DAY - 9 * HOUR;

/**
 * acc_info 글 나누기. 예: '탄천나들목 및 봉은교 구조개선공사-일시 : 26.4.7(화)10:00~27.2.28(일) 23:59-장소 : 봉은교-통제 : 양방향 전면통제'
 * → { title: '탄천나들목 및 봉은교 구조개선공사', period: '26.4.7(화)10:00~27.2.28(일) 23:59', place: '봉은교', control: '양방향 전면통제' }
 * 형식이 다르면 글 전체가 title이 됩니다.
 */
export function parseAccText(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const out = { title: '', period: '', place: '', control: '' };
  if (!s) return out;
  const parts = s.split(/-(?=\s*(?:일시|장소|구간|통제|규제|내용)\s*:)/);
  out.title = parts[0].trim();
  for (const part of parts.slice(1)) {
    const m = /^\s*(일시|장소|구간|통제|규제|내용)\s*:\s*(.*)$/.exec(part);
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === '일시') out.period = v;
    else if (m[1] === '장소' || m[1] === '구간') out.place = out.place || v;
    else if (m[1] === '통제' || m[1] === '규제') out.control = v;
  }
  return out;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
/** AccInfo 한 행 → 화면 · 매칭용 값. 보여 주지 않는 종류이거나 좌표가 없으면 null */
export function normalizeAcc(row) {
  if (!row) return null;
  const type = String(row.acc_type ?? '').trim().toUpperCase();
  const info = INCIDENT_TYPES[type];
  if (!info) return null;
  const pos = tmToLatLon(row.grs80tm_x, row.grs80tm_y);
  if (!pos) return null;
  const text = String(row.acc_info ?? '').replace(/\s+/g, ' ').trim();
  const t = parseAccText(text);
  return {
    id: String(row.acc_id ?? '').trim(), type, dtype: String(row.acc_dtype ?? '').trim(), label: info.label, kind: info.kind, rank: info.rank,
    lat: r6(pos.lat), lon: r6(pos.lon), startAt: kstMs(row.occr_date, row.occr_time), endAt: kstMs(row.exp_clr_date, row.exp_clr_time),
    title: t.title || info.label, period: t.period, place: t.place, control: t.control, text,
    linkId: String(row.link_id ?? '').trim(), roadCode: String(row.acc_road_code ?? '').trim(),
  };
}

// ── 거리(짧은 거리용 평면 근사, 수 km 안에서 오차 1% 미만) ──
const R = 6371008.8;
const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
const xy = (p, lat0) => [p.lon * RAD * R * Math.cos(lat0 * RAD), p.lat * RAD * R];
/** 두 점 사이 거리(m) */
export function distanceM(a, b) {
  const lat0 = (a.lat + b.lat) / 2, [x1, y1] = xy(a, lat0), [x2, y2] = xy(b, lat0);
  return Math.hypot(x2 - x1, y2 - y1);
}
/** 점 p에서 꺾은선 path([{lat, lon, name?}])까지 가장 가까운 거리(m)와 가장 가까운 정류장 번호 */
export function distToPath(p, path) {
  const pts = path.filter(ok);
  if (!pts.length) return { distM: Infinity, idx: -1 };
  const [px, py] = xy(p, p.lat);
  const P = pts.map((q) => xy(q, p.lat));
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const [ax, ay] = P[i];
    if (i === P.length - 1) { best = Math.min(best, Math.hypot(px - ax, py - ay)); break; }
    const [bx, by] = P[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + u * dx), py - (ay + u * dy)));
  }
  let idx = 0, near = Infinity;
  P.forEach(([x, y], i) => { const d = Math.hypot(px - x, py - y); if (d < near) { near = d; idx = i; } });
  return { distM: best, idx: path.indexOf(pts[idx]) };
}

/**
 * 돌발정보 목록 → 통학 경로 주변만(경로 위 → 국민대 근처, 진행 중 → 예정, 사고 → 집회 → 기상 → 공사, 가까운 순)
 * @param {Array} list normalizeAcc 결과
 * @param {{ trips?:Array<{no:string, path?:Array<{lat,lon,name}>}>, nowMs:number, campus?:{lat,lon} }} o
 * @returns {Array} 각 항목에 where('route'|'campus') · routes(노선 번호) · nearStop · distM · campusM · status('active'|'soon')
 */
export function matchIncidents(list, { trips = [], nowMs = Date.now(), campus = KU_POINT, routeBufferM = MATCH.routeBufferM,
  campusRadiusM = MATCH.campusRadiusM, soonMin = MATCH.soonMin, limit = MATCH.limit } = {}) {
  const out = [];
  for (const inc of list || []) {
    if (!inc || !ok(inc)) continue;
    if (inc.endAt != null && inc.endAt <= nowMs) continue; // 이미 끝남
    const soon = inc.startAt != null && inc.startAt > nowMs;
    if (soon && inc.startAt - nowMs > soonMin * 60_000) continue; // 너무 나중에 시작
    const routes = [];
    let best = null;
    for (const t of trips) {
      if (!t?.path?.length) continue;
      const d = distToPath(inc, t.path);
      if (d.distM > routeBufferM) continue;
      if (!routes.includes(t.no)) routes.push(t.no);
      if (!best || d.distM < best.distM) best = { distM: d.distM, stop: t.path[d.idx]?.name || null };
    }
    const campusM = distanceM(inc, campus);
    const where = routes.length ? 'route' : campusM <= campusRadiusM ? 'campus' : null;
    if (!where) continue;
    out.push({ ...inc, where, routes, nearStop: best?.stop ?? null, distM: Math.round(where === 'route' ? best.distM : campusM), campusM: Math.round(campusM), status: soon ? 'soon' : 'active' });
  }
  const w = (x) => (x.where === 'route' ? 0 : 1), s = (x) => (x.status === 'active' ? 0 : 1);
  out.sort((a, b) => w(a) - w(b) || s(a) - s(b) || a.rank - b.rank || a.distM - b.distM);
  return out.slice(0, limit);
}

// ── 화면 문구(서버 · 화면 공통) ──
const roundDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.max(50, Math.round(m / 50) * 50)}m`);
/** '171 · 1711 경로 위' / '국민대에서 약 600m' */
export function whereText(it) {
  return it.where === 'route' ? `${it.routes.join(' · ')} 경로 위` : `국민대에서 약 ${roundDist(it.campusM ?? it.distM)}`;
}
/** 언제: acc_info의 일시 글이 있으면 그대로, 없으면 시작~해제 시각 */
export function periodText(it, nowMs = Date.now()) {
  if (it.period) return it.period;
  if (it.startAt && it.endAt) return `${fmtKst(it.startAt, nowMs)} ~ ${fmtKst(it.endAt, nowMs)}`;
  if (it.endAt) return `${fmtKst(it.endAt, nowMs)}까지`;
  if (it.startAt) return `${fmtKst(it.startAt, nowMs)}부터`;
  return '';
}
/** 짧은 상태: '10:00부터 예정' / '27.2.28까지' / '진행 중' */
export function statusText(it, nowMs = Date.now()) {
  if (it.status === 'soon' && it.startAt) return `${fmtKst(it.startAt, nowMs)}부터 예정`;
  return it.endAt ? `${fmtKst(it.endAt, nowMs)}까지` : '진행 중';
}
/** 접은 줄 제목: '경로 위 공사 중' / '국민대 근처 집회 · 행사 예정' */
export function headline(it) {
  const place = it.where === 'route' ? '경로 위' : '국민대 근처';
  const tail = it.status === 'soon' ? ' 예정' : it.kind === 'work' || it.kind === 'event' ? ' 중' : '';
  return `${place} ${it.label}${tail}`;
}
