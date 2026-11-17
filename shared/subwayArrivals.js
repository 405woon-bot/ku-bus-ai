// 서울시 실시간 지하철 도착정보(realtimeStationArrival) 해석 — 서버(실제 응답)와 미리보기(예시 응답)가 같은 코드
//   http://swopenapi.seoul.go.kr/api/subway/{KEY}/json/realtimeStationArrival/0/20/{역명}
//   정상: { errorMessage: { code: 'INFO-000', … }, realtimeArrivalList: [ … ] }
//   데이터 없음 · 오류: 맨 위에 { status, code: 'INFO-200' | 'INFO-100' | 'ERROR-337' …, message }
//   barvlDt(남은 초)는 코레일 노선 등에서 0(=모름)인 경우가 많아, 0이면 arvlMsg2 · arvlCd로 보수적으로(더 일찍 온다고) 추정합니다.

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/** 역 이름 비교용: 공백 · 끝의 '역' · 괄호 부분 제거 */
export const stationKey = (s) => str(s).replace(/\(.*?\)/g, '').replace(/\s+/g, '').replace(/역$/, '');

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
 * 한 줄 → { subwayId, updn, next(방면 역), dest(종착), etaSec(받은 시각 기준), approx, express, last, code, msg }
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
    express: /급행|특급/.test(str(r?.btrainSttus)), last: str(r?.lstcarAt) === '1', msg,
  };
}

/** 응답 전체 → { status, code, message, rows } */
export function parseSubwayArrivals(json, fetchedMs) {
  const st = subwayStatus(json);
  if (st.status !== 'ok') return { ...st, rows: [] };
  return { ...st, rows: json.realtimeArrivalList.map((r) => parseSubwayRow(r, fetchedMs)).filter(Boolean) };
}

/**
 * 이 구간에 탈 수 있는 열차만(가까운 순): 같은 노선 · 같은 방향(다음 역이 같음) · 내 하차역 전에 끝나지 않는 열차 · (일반 경로면) 급행 제외.
 * 방향을 확인할 수 없으면 쓰지 않음(보수적 → 표준 대기 시간으로)
 * @param {Array} rows parseSubwayRow 결과  @param {object} leg 경로의 지하철 구간(shared/transitPlan.js)
 */
export function trainsForLeg(rows, leg) {
  const next = stationKey(leg?.next), stations = (leg?.stations || []).map(stationKey), last = stations.length - 1;
  const updn = !next && leg?.subwayId && leg.subwayId !== '1002' ? ({ 1: '상행', 2: '하행' }[leg.wayCode] || null) : null;
  return (rows || []).filter((r) => {
    if (leg?.subwayId && r.subwayId && r.subwayId !== leg.subwayId) return false;
    if (next) { if (stationKey(r.next) !== next) return false; } else if (!updn || r.updn !== updn) return false;
    if (r.express && !/급행/.test(leg?.lineName || '')) return false;
    const di = stations.indexOf(stationKey(r.dest));
    return !(di >= 0 && di < last); // 하차역보다 앞에서 끝나는 열차
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
