// 테스트용 기상청 초단기실황(getUltraSrtNcst) 응답 — 공공데이터포털 · 기상청 안내의 예상 형식(실제 응답은 '확인 필요'), 값은 가상입니다.
import { readFileSync } from 'node:fs';

/** 정상 응답(JSON, dataType=JSON) */
export function ncstJson(items, { code = '00', msg = 'NORMAL_SERVICE' } = {}) {
  return JSON.stringify({ response: { header: { resultCode: code, resultMsg: msg }, body: code === '00' ? { dataType: 'JSON', items: { item: items }, pageNo: 1, numOfRows: 20, totalCount: items.length } : undefined } });
}
/** 정상 응답(XML) */
export function ncstXml(items, { code = '00', msg = 'NORMAL_SERVICE' } = {}) {
  const body = items.map((it) => `<item>${Object.entries(it).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><header><resultCode>${code}</resultCode><resultMsg>${msg}</resultMsg></header><body><dataType>XML</dataType><items>${body}</items><numOfRows>20</numOfRows><pageNo>1</pageNo><totalCount>${items.length}</totalCount></body></response>`;
}
/** 공공데이터포털 게이트웨이 오류(XML) — 기존 고정 응답 재사용 */
export const GATEWAY_KEY = readFileSync(new URL('./gateway_key.xml', import.meta.url), 'utf8');
export const GATEWAY_QUOTA = readFileSync(new URL('./gateway_quota.xml', import.meta.url), 'utf8');

const VALUES = { rain: { PTY: '1', RN1: '1.5', T1H: '7.2', REH: '92', WSD: '2.1', UUU: '-1.1', VVV: '1.6', VEC: '146' }, clear: { PTY: '0', RN1: '0', T1H: '9.8', REH: '55', WSD: '1.2' } };
export const ncstItems = (baseDate, baseTime, kind = 'rain', nx = 60, ny = 128) =>
  Object.entries(VALUES[kind]).map(([category, obsrValue]) => ({ baseDate, baseTime, category, nx, ny, obsrValue }));

/**
 * fetch 대신 쓰는 가짜 기상청 서버. calls에 요청 URL을 남깁니다.
 * @param {{ kind?:'rain'|'clear', noData?:(baseTime:string)=>boolean, fail?:(url:URL)=>any }} o
 */
export function fakeKmaFetch({ kind = 'rain', noData = () => false, fail } = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const custom = fail && (await fail(u));
    if (custom) return custom;
    if (!u.pathname.endsWith('/getUltraSrtNcst')) return { ok: false, status: 404, text: async () => 'not found' };
    const p = u.searchParams;
    if (noData(p.get('base_time'))) return { ok: true, status: 200, text: async () => ncstJson([], { code: '03', msg: 'NO_DATA' }) };
    return { ok: true, status: 200, text: async () => ncstJson(ncstItems(p.get('base_date'), p.get('base_time'), kind, Number(p.get('nx')), Number(p.get('ny')))) };
  };
  fn.calls = calls;
  return fn;
}
