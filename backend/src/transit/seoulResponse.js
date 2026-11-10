// 서울시 버스 API 응답 해석 — XML(기본)·JSON 모두. 형식은 서울특별시 버스 Open API 활용가이드(노선정보조회 2023-03-08,
// 정류소정보조회 2025-09-24, 버스도착정보조회 2025-08-14, 버스위치정보조회 2023-05-30)의 예제를 따릅니다.
//
//   <ServiceResult><comMsgHeader/>
//     <msgHeader><headerCd>0</headerCd><headerMsg>정상적으로 처리되었습니다.</headerMsg><itemCount>0</itemCount></msgHeader>
//     <msgBody><itemList>…</itemList><itemList>…</itemList></msgBody></ServiceResult>
//
// 인증키·호출 한도 오류는 공공데이터포털 게이트웨이 형식(comMsgHeader/cmmMsgHeader의 returnReasonCode·returnAuthMsg)으로
// 올 수 있어 함께 확인합니다(이 부분은 가이드에 표가 없어 포털 공통 오류코드 기준 — 실제 응답으로 확인 필요).

/** 가이드의 오류코드 안내(네 서비스 공통) */
export const HEADER_CODES = Object.freeze({
  0: '정상적으로 처리되었습니다', 1: '시스템 오류가 발생하였습니다', 2: '잘못된 쿼리 요청입니다', 3: '정류소를 찾을 수 없습니다',
  4: '노선을 찾을 수 없습니다', 5: '잘못된 위치로 요청을 하였습니다', 6: '실시간 정보를 읽을 수 없습니다', 7: '경로 검색 결과가 존재하지 않습니다',
  8: '운행 종료되었습니다',
});

/**
 * 오류 종류(kind): no-key · network · timeout · http · parse · quota · auth · temporary · api · config
 * 폴백 판단과 화면 안내 문구에 씁니다.
 */
export class SeoulApiError extends Error {
  constructor(kind, message, detail) { super(message); this.name = 'SeoulApiError'; this.kind = kind; this.detail = detail; }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e.toLowerCase()]));
}
/** 한 단계 자식 요소 → { 태그: 값 } (itemList 안은 모두 단순 값) */
function leafFields(xml) {
  const out = {};
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2] === undefined ? '' : decode(m[2].trim());
  return out;
}
const block = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`).exec(xml);
  return m ? leafFields(m[1]) : {};
};

function gatewayCheck(com, raw = '') {
  const code = String(com.returnReasonCode ?? '').trim();
  const auth = String(com.returnAuthMsg ?? '').trim();
  const text = `${auth} ${raw}`;
  if (code === '22' || /LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(text)) throw new SeoulApiError('quota', '서울시 API 호출 한도를 넘었어요', auth || code);
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|UNREGISTERED_IP|DEADLINE_HAS_EXPIRED/.test(text) || ['20', '30', '31', '32'].includes(code)) {
    throw new SeoulApiError('auth', `인증키 오류(${auth || code}) — 키 값·활용 신청 승인·서비스 기간을 확인하세요`, auth || code);
  }
  if (code && !['0', '00'].includes(code)) throw new SeoulApiError('api', `서울시 API 오류(${code}${auth ? ` ${auth}` : ''})`, code);
}

/**
 * @param {string} text 응답 본문(XML 또는 JSON)
 * @returns {{ code:string, message:string, items:Array<Record<string,string>>, format:'xml'|'json' }}
 *   code '0' 정상 · '3'/'4'/'7' 찾지 못함 · '8' 운행 종료 → items는 빈 배열일 수 있음
 * @throws {SeoulApiError} parse · quota · auth · temporary(6) · api(1,2,5)
 */
export function parseSeoulResponse(text) {
  const t = String(text ?? '').replace(/^﻿/, '').trim();
  if (!t) throw new SeoulApiError('parse', '서울시 API가 빈 응답을 보냈어요');
  let header, com, items, format;
  if (t[0] === '{' || t[0] === '[') {
    let j;
    try { j = JSON.parse(t); } catch { throw new SeoulApiError('parse', '서울시 API 응답(JSON)을 해석하지 못했어요'); }
    const root = j.ServiceResult || j.OpenAPI_ServiceResponse || j;
    header = root.msgHeader || {};
    com = root.comMsgHeader || root.cmmMsgHeader || {};
    const list = root.msgBody?.itemList;
    items = (Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : [])
      .map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? '' : String(v)])));
    format = 'json';
  } else if (t[0] === '<') {
    if (!/>\s*$/.test(t) || !/<\/(ServiceResult|OpenAPI_ServiceResponse|response)\s*>\s*$/.test(t)) {
      gatewayCheck({}, t); // 잘린 응답이라도 한도·인증 문구가 있으면 그 오류로
      throw new SeoulApiError('parse', '서울시 API 응답(XML)이 끝까지 오지 않았거나 형식이 달라요');
    }
    header = block(t, 'msgHeader');
    com = { ...block(t, 'cmmMsgHeader'), ...block(t, 'comMsgHeader') };
    items = [...t.matchAll(/<itemList(?:\s[^>]*)?>([\s\S]*?)<\/itemList\s*>/g)].map((m) => leafFields(m[1]));
    format = 'xml';
  } else {
    gatewayCheck({}, t);
    throw new SeoulApiError('parse', '서울시 API가 XML·JSON이 아닌 응답을 보냈어요(오류 페이지일 수 있음)');
  }
  gatewayCheck(com);
  const code = String(header.headerCd ?? '').trim();
  const message = String(header.headerMsg ?? HEADER_CODES[code] ?? '').trim();
  if (!code) throw new SeoulApiError('parse', '응답에 결과 코드(headerCd)가 없어요');
  if (code === '6') throw new SeoulApiError('temporary', `서울시 API: ${message || HEADER_CODES[6]}`, code);
  if (['1', '2', '5'].includes(code) || !(code in HEADER_CODES)) throw new SeoulApiError('api', `서울시 API 오류(${code}): ${message}`, code);
  return { code, message, items: code === '0' ? items : [], format };
}
