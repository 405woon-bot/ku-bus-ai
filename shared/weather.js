// 기상청 단기예보 조회서비스 · 초단기실황조회(getUltraSrtNcst) 해석 — 서버와 화면이 같이 씁니다.
//
// ※ 응답 형식 '확인 필요': 아직 실제 응답을 받아 보지 못했습니다. 아래는 공공데이터포털 · 기상청 활용 안내와 공개된 예제를 따른 것이고,
//   값이 예상과 다르면(항목이 없거나 숫자가 아니면) 그 값은 null로 두고, 강수형태 · 강수량을 둘 다 못 읽으면 날씨를 통째로 뺍니다.
//   예상 형식: response.header.resultCode('00') · response.body.items.item[] = { baseDate, baseTime, category, nx, ny, obsrValue }
//   category: T1H 기온(℃) · RN1 1시간 강수량(mm) · PTY 강수형태(코드) · REH 습도(%) · WSD 풍속(m/s) · UUU · VVV · VEC
//   결측: +900 이상 · -900 이하 값

/** 강수형태(PTY) 코드 — 초단기실황은 0 · 1 · 2 · 3 · 5 · 6 · 7, 4(소나기)는 단기예보 코드지만 들어와도 읽음 */
export const PTY_TEXT = Object.freeze({ 0: '없음', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기', 5: '빗방울', 6: '빗방울 · 눈날림', 7: '눈날림' });

// ── 위경도 → 기상청 격자(nx, ny): 기상청 활용 안내의 람베르트 정각원추도법(5km 격자) 상수 ──
const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
export function latLonToGrid(lat, lon) {
  const D = Math.PI / 180, re = RE / GRID, s1 = SLAT1 * D, s2 = SLAT2 * D, ol = OLON * D, oa = OLAT * D;
  const q = (v) => Math.tan(Math.PI * 0.25 + v * 0.5);
  const sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(q(s2) / q(s1));
  const sf = (q(s1) ** sn * Math.cos(s1)) / sn;
  const ro = (re * sf) / q(oa) ** sn;
  const ra = (re * sf) / q(lat * D) ** sn;
  let th = lon * D - ol;
  if (th > Math.PI) th -= 2 * Math.PI;
  if (th < -Math.PI) th += 2 * Math.PI;
  th *= sn;
  return { nx: Math.floor(ra * Math.sin(th) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(th) + YO + 0.5) };
}
/** 국민대학교(서울 성북구 정릉동, 국민대학교앞 정류장 북위 37.6106° · 동경 126.9970°) → 위 식으로 계산한 격자. 테스트로 확인 */
export const KU_GRID = Object.freeze({ nx: 60, ny: 128 });

// ── 발표 시각(서울) ──
const HOUR = 3600_000;
const p2 = (n) => String(n).padStart(2, '0');
const kstParts = (ms) => { const d = new Date(ms + 9 * HOUR); return { date: `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`, hh: d.getUTCHours() }; };
/**
 * 초단기실황은 매시 정시 자료. 제공 시작 시각이 안내마다 달라(10분 · 40분 뒤) '확인 필요' —
 * 지금에서 lagMin(기본 10분)을 뺀 시각의 정시를 먼저 부르고, 자료가 없으면(NODATA) 한 시간 전을 부릅니다(prevBase).
 * @returns {{ baseDate:string, baseTime:string }}
 */
export function ncstBase(nowMs, lagMin = 10) {
  const k = kstParts(nowMs - lagMin * 60_000);
  return { baseDate: k.date, baseTime: `${p2(k.hh)}00` };
}
export function baseMs({ baseDate, baseTime }) {
  const d = String(baseDate), t = String(baseTime).padStart(4, '0');
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2) - 9, +t.slice(2, 4));
}
export function prevBase(b) {
  const k = kstParts(baseMs(b) - HOUR);
  return { baseDate: k.date, baseTime: `${p2(k.hh)}00` };
}

// ── 값 읽기 ──
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > -900 && n < 900 ? n : null; // ±900 넘으면 결측
};
/**
 * 1시간 강수량 → mm(숫자). 실황은 '0' · '1.5' 같은 숫자로 온다고 안내되어 있고(확인 필요),
 * 예보식 글('강수없음' · '1mm 미만' · '30.0~50.0mm' · '50.0mm 이상')이 와도 읽습니다. 못 읽으면 null.
 */
export function parseRn1(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/강수\s*없음/.test(s)) return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return n > -900 && n < 900 ? Math.max(0, n) : null; // ±900 넘으면 결측
  if (/미만/.test(s)) return 0.5;
  const m = /(-?\d+(?:\.\d+)?)/.exec(s);
  return m ? Math.max(0, Number(m[1])) : null;
}

/**
 * 응답 항목들 → 화면 · 설명용 요약. 강수형태와 강수량을 둘 다 못 읽으면 null(날씨를 보여 주지 않음).
 * @param {Array<{ category, obsrValue, baseDate?, baseTime? }>} items
 */
export function summarizeNcst(items) {
  const list = Array.isArray(items) ? items : [];
  const raw = {};
  for (const it of list) if (it && it.category) raw[String(it.category).trim().toUpperCase()] = it.obsrValue == null ? '' : String(it.obsrValue).trim();
  const ptyNum = num(raw.PTY);
  const pty = ptyNum === null ? null : Math.round(ptyNum);
  const rn1Mm = parseRn1(raw.RN1);
  if (pty === null && rn1Mm === null) return null;
  const first = list.find((x) => x && x.baseDate) || {};
  const baseDate = String(first.baseDate ?? '').trim(), baseTime = String(first.baseTime ?? '').trim().padStart(4, '0');
  const obsAt = /^\d{8}$/.test(baseDate) && /^\d{4}$/.test(baseTime) ? baseMs({ baseDate, baseTime }) : null;
  const ptyText = pty === null ? null : (PTY_TEXT[pty] ?? '알 수 없음');
  return {
    baseDate, baseTime, obsAt, pty, ptyText, rn1Mm, t1h: num(raw.T1H), reh: num(raw.REH), wsd: num(raw.WSD),
    wet: (pty !== null && pty !== 0) || (rn1Mm !== null && rn1Mm > 0), raw,
  };
}

/** 짧은 글: '비 · 1시간 1.5mm' / '강수 없음' / '눈 · 1시간 0.5mm' */
export function weatherText(w) {
  if (!w) return '';
  if (!w.wet) return '강수 없음';
  const kind = w.pty && w.pty !== 0 ? w.ptyText : '비';
  return w.rn1Mm ? `${kind} · 1시간 ${w.rn1Mm}mm` : kind;
}
