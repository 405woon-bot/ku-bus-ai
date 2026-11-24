// v2.4.1 점검: 남은 시간을 구하는 규칙(rowEta)을 따로 꺼냈어도 열차 해석(parseSubwayRow)은 예전과 똑같은지 — 예전 코드와 같은 값인지 조합으로 비교.
//   열차는 모두 예시입니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubwayRow, rowEta } from './subwayArrivals.js';

const AT = Date.parse('2026-11-25T08:00:30+09:00');
const base = { subwayId: '1004', updnLine: '상행', trainLineNm: '진접행 - 동대문방면', bstatnNm: '진접', btrainSttus: '일반', lstcarAt: '0', recptnDt: '2026-11-25 08:00:00' };

// v2.4.0까지의 parseSubwayRow(그대로 옮김) — 바뀐 코드가 같은 답을 내는지 비교용
const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const recptnMs = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(str(s)); return m ? Date.parse(`${m[1]}T${m[2]}+09:00`) : null; };
const BY_CODE = { 3: 45, 4: 75, 5: 60 };
function oldParse(r, fetchedMs) {
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

test('rowEta: 남은 시간을 구한 방법 — 초 · 도착/진입 · 문구 · 몇 번째 전역(어림) · 전역 코드(어림) · 떠남 · 지난 기록 · 모름', () => {
  const e = (o) => rowEta({ ...base, barvlDt: '0', arvlCd: '99', arvlMsg2: '', ...o }, AT);
  assert.deepEqual(e({ barvlDt: '240' }), { how: 'seconds', eta: 210, approx: false });
  assert.deepEqual([e({ arvlCd: '1', arvlMsg2: '서울 도착' }), e({ arvlCd: '0' })].map((x) => [x.how, x.eta]), [['arrive', 0], ['arrive', 0]]);
  assert.deepEqual(e({ arvlMsg2: '3분 20초 후 (혜화)' }), { how: 'message', eta: 170, approx: false });
  assert.deepEqual(e({ arvlMsg2: '[2]번째 전역 (서강대)' }), { how: 'stationsAway', eta: 150, approx: true }, '2 × 90초 − 받은 뒤 흐른 30초');
  assert.deepEqual([e({ arvlCd: '3' }), e({ arvlCd: '4' }), e({ arvlCd: '5' })].map((x) => [x.how, x.eta, x.approx]), [['code', 15, true], ['code', 45, true], ['code', 30, true]]);
  assert.deepEqual([e({ arvlCd: '2', arvlMsg2: '서울 출발' }).how, e({ recptnDt: '2026-11-25 07:54:00', barvlDt: '240' }).how, e({ arvlMsg2: '운행중' }).how], ['departed', 'stale', 'unknown']);
  assert.equal(parseSubwayRow({ ...base, arvlCd: '2' }, AT), null, '떠난 열차는 예전처럼 쓰지 않음');
});

test('parseSubwayRow는 예전 코드와 같은 답 — 받은 시각 · 남은 초 · 도착 코드 · 문구 3,402가지 조합', () => {
  const recptns = ['2026-11-25 08:00:00', '2026-11-25 07:54:00', '2026-11-25 08:01:00', 'bad', '', null];
  const secs = ['0', '30', '120', '', null, '-5', 'abc'];
  const codes = ['0', '1', '2', '3', '4', '5', '99', '', null];
  const msgs = ['', '3분 20초 후 (혜화)', '[4]번째 전역 (한성대입구)', '2분 후', '45초 후', '전역 도착', '서울 도착', '운행중', '[12]번째 전역'];
  let n = 0;
  for (const recptnDt of recptns) for (const barvlDt of secs) for (const arvlCd of codes) for (const arvlMsg2 of msgs) {
    const r = { ...base, recptnDt, barvlDt, arvlCd, arvlMsg2 };
    assert.deepEqual(parseSubwayRow(r, AT), oldParse(r, AT), JSON.stringify(r));
    n++;
  }
  assert.equal(n, 3402);
});
