// 서울시 실시간 지하철 도착정보(realtimeStationArrival) 해석 — 서버(실제 응답)와 미리보기(예시 응답)가 같은 코드
//   http://swopenapi.seoul.go.kr/api/subway/{KEY}/json/realtimeStationArrival/0/20/{역명}
//   정상: { errorMessage: { code: 'INFO-000', … }, realtimeArrivalList: [ … ] }
//   데이터 없음 · 오류: 맨 위에 { status, code: 'INFO-200' | 'INFO-100' | 'ERROR-337' …, message }
//   barvlDt(남은 초)는 코레일 노선 등에서 0(=모름)인 경우가 많아, 0이면 arvlMsg2 · arvlCd로 보수적으로(더 일찍 온다고) 추정합니다.
//   v2.3.0 실시간 허용 목록(19개 노선) · 노선 묶음별 열차 고르기(직통 · ITX 제외, 애매하면 쓰지 않고 배차로 예상)

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/** 역 이름 비교용: 공백 · 끝의 '역' · 괄호 부분 제거 */
export const stationKey = (s) => str(s).replace(/\(.*?\)/g, '').replace(/\s+/g, '').replace(/역$/, '');

/* ── v2.3.0 실시간 허용 목록 ──
 * 서울시 실시간을 부르는 노선(번호 → [이름, 묶음]). 여기에 없는 노선(번호가 없는 인천1 · 2호선 · 김포골드 · 의정부 · 에버라인 등)은
 * 서울시를 부르지 않고 배차로 예상해요('첫 지하철 실시간 없음'). 번호는 shared/transitPlan.js의 '노선 이름 → 번호'와 같아요.
 *   metro  = 1~9호선: 지금까지 쓰던 규칙 그대로(열차 종류 칸이 비면 일반) + 직통 · ITX는 뺌
 *   strict = 급행 · 직통 · ITX가 다니는 노선: '일반'이라고 적힌 열차만(급행 경로면 '급행'도) — 빈 칸 · 처음 보는 값은 쓰지 않음
 *   plain  = 급행이 없는 노선: 빈 칸 또는 '일반'만
 * 공식 번호 표는 확인하지 못했어요(확인 필요). 번호가 틀리면 그 노선은 열차를 고르지 못해 배차로 예상(안전하게 빠짐) — /api/subway/test로 확인
 */
const entry = (name, group) => Object.freeze([name, group]);
export const LIVE_LINES = Object.freeze({
  1001: entry('1호선', 'metro'), 1002: entry('2호선', 'metro'), 1003: entry('3호선', 'metro'), 1004: entry('4호선', 'metro'), 1005: entry('5호선', 'metro'),
  1006: entry('6호선', 'metro'), 1007: entry('7호선', 'metro'), 1008: entry('8호선', 'metro'), 1009: entry('9호선', 'metro'),
  1063: entry('경의중앙선', 'strict'), 1065: entry('공항철도', 'strict'), 1067: entry('경춘선', 'strict'), 1075: entry('수인분당선', 'strict'),
  1077: entry('신분당선', 'plain'), 1092: entry('우이신설선', 'plain'), 1093: entry('서해선', 'plain'), 1081: entry('경강선', 'plain'),
  1094: entry('신림선', 'plain'), 1032: entry('GTX-A', 'plain'),
});
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 노선 번호 → { id, name, group } — 허용 목록 밖이면 null */
export function liveLine(subwayId) {
  const id = str(subwayId);
  if (!id || !hasOwn(LIVE_LINES, id)) return null;
  const [name, group] = LIVE_LINES[id];
  return { id, name, group };
}

/**
 * 비상 끄기(SEOUL_SUBWAY_OFF_LINES='1065,1032') → { off: Set(허용 목록 안의 번호), ignored: 목록에 없거나 숫자가 아닌 칸 수 }
 * 적힌 글자는 그대로 내보내지 않음(실수로 다른 값을 넣었을 때 /api/health에 드러나지 않게 개수만)
 */
export function parseOffLines(text) {
  const off = new Set();
  let ignored = 0;
  for (const raw of str(text).split(/[\s,;]+/)) {
    if (!raw) continue;
    if (liveLine(raw)) off.add(raw); else ignored++;
  }
  return { off, ignored };
}

/** 이 지하철 구간에 서울시 실시간을 써도 되는지: 허용 목록 밖 → reason 'line', 비상 끄기로 끈 노선 → reason 'off' */
export function liveSupport(leg, off = null) {
  const l = liveLine(leg?.subwayId);
  if (!l) return { ok: false, reason: 'line' };
  if (off && typeof off.has === 'function' && off.has(l.id)) return { ok: false, reason: 'off', line: l };
  return { ok: true, line: l };
}

/** 응답 코드 → 상태 */
export function subwayStatus(json) {
  const em = json?.errorMessage;
  const code = str(em?.code || json?.code || json?.RESULT?.CODE);
  const message = str(em?.message || json?.message || json?.RESULT?.MESSAGE);
  if (code === 'INFO-000' && Array.isArray(json?.realtimeArrivalList)) return { status: 'ok', code, message };
  if (code === 'INFO-200') return { status: 'nodata', code, message: message || '해당하는 데이터가 없어요' };
  if (code === 'INFO-100') return { status: 'auth', code, message: message || '인증키가 올바르지 않아요' };
  if (code === 'ERROR-337') return { status: 'quota', code, message: message || '하루 호출 한도를 넘었어요' };
  return { status: 'api', code: code || 'unknown', message: message || '응답 형식이 달라요' };
}

const recptnMs = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(str(s)); return m ? Date.parse(`${m[1]}T${m[2]}+09:00`) : null; };
// 남은 시간을 모를 때의 보수적 추정(실제보다 일찍 온다고 봄 → 놓치지 않게)
const BY_CODE = { 3: 45, 4: 75, 5: 60 }; // 전역 출발 · 전역 진입 · 전역 도착

/**
 * 한 줄 → { subwayId, updn, next(방면 역), dest(종착), etaSec(받은 시각 기준), approx, express, type(열차 종류 원문), last, code, msg }
 * 떠난 열차(arvlCd 2)와 5분 넘게 지난 기록은 null
 */
export function parseSubwayRow(r, fetchedMs) {
  const code = num(r?.arvlCd);
  if (code === 2) return null;
  const at = recptnMs(r?.recptnDt);
  let age = at != null && fetchedMs != null ? (fetchedMs - at) / 1000 : 0;
  if (age > 300) return null;
  if (!(age >= 0)) age = 0;
  const msg = str(r?.arvlMsg2), dt = num(r?.barvlDt);
  let eta = null, approx = false;
  if (dt > 0) eta = dt - age;
  else if (code === 0 || code === 1) eta = 0;
  else {
    const m = /(?:(\d+)\s*분)?\s*(?:(\d+)\s*초)?\s*후/.exec(msg);
    if (m && (m[1] || m[2])) eta = Number(m[1] || 0) * 60 + Number(m[2] || 0) - age;
    else {
      const k = /\[?(\d+)\]?\s*번째\s*전역/.exec(msg);
      if (k) { eta = Number(k[1]) * 90 - age; approx = true; } else if (BY_CODE[code]) { eta = BY_CODE[code] - age; approx = true; }
    }
  }
  if (eta == null) return null;
  const line = str(r?.trainLineNm);
  return {
    subwayId: str(r?.subwayId), updn: str(r?.updnLine), next: (/[-–]\s*(.+?)\s*방면/.exec(line) || [])[1] || '',
    dest: str(r?.bstatnNm), etaSec: Math.max(0, Math.round(eta)), approx, code,
    express: /급행|특급/.test(str(r?.btrainSttus)), type: str(r?.btrainSttus).slice(0, 12), last: str(r?.lstcarAt) === '1', msg,
  };
}

/** 응답 전체 → { status, code, message, rows } */
export function parseSubwayArrivals(json, fetchedMs) {
  const st = subwayStatus(json);
  if (st.status !== 'ok') return { ...st, rows: [] };
  return { ...st, rows: json.realtimeArrivalList.map((r) => parseSubwayRow(r, fetchedMs)).filter(Boolean) };
}

const NONSTOP = /직통|ITX/i; // 중간역을 건너뛰는 열차(공항철도 직통 · ITX-청춘 등)
/** v2.3.0 열차 종류가 이 구간에 맞는지(노선 묶음별) */
function typeOk(r, group, expressLeg) {
  const t = str(r?.type);
  if (group === 'strict') return t === '일반' || (expressLeg && t === '급행');
  if (group === 'plain') return t === '' || t === '일반';
  if (NONSTOP.test(t)) return false; // 1~9호선(과 목록 밖 노선): 직통 · ITX는 언제나 뺌
  return expressLeg ? !/특급/.test(t) : !r?.express; // 급행 경로: 특급만 더 뺌 · 일반 경로: 급행 · 특급 뺌(예전과 같음)
}

/**
 * 이 구간에 탈 수 있는 열차만(가까운 순): 같은 노선 · 같은 방향(다음 역이 같음) · 열차 종류(노선 묶음별, v2.3.0) · 내 하차역 전에 끝나지 않는 열차.
 * 방향을 확인할 수 없으면 쓰지 않음(보수적 → 표준 대기 시간으로). 1~9호선만 예전처럼 상행/하행으로 대신(2호선 제외)
 * v2.3.0 구간에 노선 번호가 있으면 서울시 줄도 번호가 정확히 같아야 함(번호가 빈 줄은 뺌)
 * @param {Array} rows parseSubwayRow 결과  @param {object} leg 경로의 지하철 구간(shared/transitPlan.js)
 * @param {object|null} [drops] 뺀 이유를 셀 곳(선택) — { line: 번호 빈 줄, dir: 방향을 알 수 없는 줄, type: 열차 종류, dest: 하차역 전에 끝남 }.
 *   다른 노선 · 반대 방향처럼 원래 빠지는 열차는 세지 않음
 */
export function trainsForLeg(rows, leg, drops = null) {
  const group = liveLine(leg?.subwayId)?.group || 'metro';
  const next = stationKey(leg?.next), stations = (leg?.stations || []).map(stationKey), last = stations.length - 1;
  const expressLeg = /급행/.test(leg?.lineName || '');
  const updn = !next && group === 'metro' && leg?.subwayId && leg.subwayId !== '1002' ? ({ 1: '상행', 2: '하행' }[leg.wayCode] || null) : null;
  const drop = (k) => { if (drops) drops[k] = (drops[k] || 0) + 1; return false; };
  return (rows || []).filter((r) => {
    if (leg?.subwayId) { if (!r.subwayId) return drop('line'); if (r.subwayId !== leg.subwayId) return false; }
    if (next) { if (!stationKey(r.next)) return drop('dir'); if (stationKey(r.next) !== next) return false; } else if (!updn) return drop('dir'); else if (r.updn !== updn) return false;
    if (!typeOk(r, group, expressLeg)) return drop('type');
    const di = stations.indexOf(stationKey(r.dest));
    if (di >= 0 && di < last) return drop('dest'); // 하차역보다 앞에서 끝나는 열차
    return true;
  }).sort((a, b) => a.etaSec - b.etaSec);
}

/** (미리보기) 예시 응답을 만드는 도우미 — 서울시 응답 형식 그대로. 실제 열차 정보가 아님 */
export function exampleSubwayJson({ subwayId, station, next, dest, etasSec, recptnMs: at, updn = '상행' }) {
  const two = (n) => String(n).padStart(2, '0');
  const d = new Date(at + 9 * 3600_000);
  const recptnDt = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  return {
    errorMessage: { status: 200, code: 'INFO-000', message: '정상 처리되었습니다.', link: '', developerMessage: '', total: etasSec.length },
    realtimeArrivalList: etasSec.map((s, i) => ({
      subwayId, updnLine: updn, trainLineNm: `${dest}행 - ${next}방면`, statnNm: station, btrainSttus: '일반', barvlDt: String(Math.max(0, Math.round(s))),
      bstatnNm: dest, recptnDt, arvlMsg2: s < 60 ? `${station} 진입` : `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초 후 (${next})`, arvlMsg3: next,
      arvlCd: s < 60 ? '0' : '99', lstcarAt: '0', ordkey: `0${i + 1}000${dest}0`,
    })),
  };
}
