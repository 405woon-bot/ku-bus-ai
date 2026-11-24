// 실행: node --test shared/explain.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_FLOW_KMH, NO_CAUSE_TEXT, buildFacts, causeWords, cleanAiText, delayMinutes, hasEvidence, ruleText, slowPlace, speedWord } from './explain.js';

const RAIN = { source: 'kma', wet: true, pty: 1, ptyText: '비', rn1Mm: 1.5 };
const WORK = { id: 'W', label: '공사', title: '정릉로 하수관 정비공사', where: 'route', routes: ['171'], status: 'active' };
const EVENT_SOON = { id: 'E', label: '집회 · 행사', title: '거리 행사', where: 'campus', routes: [], status: 'soon' };
const EVENT_NOW = { ...EVENT_SOON, id: 'E2', status: 'active' };
const OTHER_ROUTE = { ...WORK, id: 'W2', routes: ['1112'] };
const TRIP = { no: '171', congestion: 'heavy', cause: '정릉로', slowest: { kmh: 4.2 }, kmh: 6.4, distM: 1780, inVehicleMin: 17.8, intermediateStops: 3 };
const facts = (over = {}) => ({ '막힘 정도': '혼잡', '가장 느린 도로': '정릉로', '느린 정도': '걷는 속도 수준으로 느림', 날씨: '비',
  '주변 돌발정보': [{ 종류: '공사', 이름: '정릉로 하수관 정비공사', 위치: '경로 위', 시점: '진행 중' }], ...over });

test('지연 분: 실제 차내 시간 − 원활(시속 20km) + 정류장 20초로 달렸을 때, 반올림 · 0 아래로 안 감 · 거리 없으면 null', () => {
  assert.equal(FREE_FLOW_KMH, 20);
  // 1780m ÷ 333.3m/분 = 5.34분 + 3정류장 × 20초 = 1분 → 6.34분, 17.8 − 6.34 = 11.46 → 11
  assert.equal(delayMinutes(TRIP), 11);
  assert.equal(delayMinutes({ ...TRIP, inVehicleMin: 6 }), 0);
  assert.equal(delayMinutes({ ...TRIP, distM: null }), null, '예시 데이터(거리 없음)');
  assert.equal(delayMinutes({ ...TRIP, inVehicleMin: NaN }), null);
  assert.equal(delayMinutes(null), null);
});

test('속도 → 말: 8 미만 걷는 속도 · 12 미만 많이 · 20 미만 조금 · 그 이상 · 값 없음은 null', () => {
  assert.deepEqual([4, 7.9, 8, 11.9, 12, 19.9, 20, NaN, 0].map(speedWord),
    ['걷는 속도 수준으로 느림', '걷는 속도 수준으로 느림', '많이 느림', '많이 느림', '조금 느림', '조금 느림', null, null, null]);
});

test('가장 느린 곳: 표에 있는 도로 이름 그대로, 정류장 사이 구간은 → 대신 ~', () => {
  assert.equal(slowPlace(TRIP), '정릉로');
  assert.equal(slowPlace({ cause: '정릉3동주민센터앞→청덕초등학교입구 구간' }), '정릉3동주민센터앞~청덕초등학교입구 구간');
  assert.equal(slowPlace({ cause: null }), null);
  assert.equal(slowPlace({}), null);
});

test('사실 JSON: 키 순서 고정 · 숫자 없음 · 비/눈만 · 이 노선 경로 위 + 국민대 근처의 진행 중 돌발만(예정 · 다른 노선은 뺌)', () => {
  const f = buildFacts(TRIP, { incidents: { items: [WORK, EVENT_SOON, OTHER_ROUTE, EVENT_NOW] }, weather: RAIN });
  assert.deepEqual(Object.keys(f), ['막힘 정도', '가장 느린 도로', '느린 정도', '날씨', '주변 돌발정보']);
  assert.deepEqual(f, {
    '막힘 정도': '혼잡', '가장 느린 도로': '정릉로', '느린 정도': '걷는 속도 수준으로 느림', 날씨: '비',
    '주변 돌발정보': [
      { 종류: '공사', 이름: '정릉로 하수관 정비공사', 위치: '경로 위', 시점: '진행 중' },
      { 종류: '집회 · 행사', 이름: '거리 행사', 위치: '국민대 근처', 시점: '진행 중' },
    ],
  });
  assert.ok(!/\d/.test(JSON.stringify(f)), 'AI에 넘기는 사실에는 숫자가 없음');
  // 맑음 · 꺼진 날씨 · 오류 → 날씨 null, 눈 · 소나기는 그 이름
  for (const w of [{ source: 'kma', wet: false, pty: 0 }, { source: 'off' }, { source: 'error' }, null]) assert.equal(buildFacts(TRIP, { weather: w }).날씨, null);
  assert.equal(buildFacts(TRIP, { weather: { source: 'kma', wet: true, pty: 3, ptyText: '눈' } }).날씨, '눈');
  assert.equal(buildFacts(TRIP, { weather: { source: 'kma', wet: true, pty: 0, rn1Mm: 0.5 } }).날씨, '비', '강수형태 없이 강수량만 있으면 비');
  assert.equal(buildFacts(TRIP, { weather: { source: 'kma', wet: true, pty: 9, ptyText: '알 수 없음', rn1Mm: null } }).날씨, null);
  // 보통 · 표에 없는 구간 · 원인 구간 없음
  const sect = buildFacts({ no: '1711', congestion: 'heavy', cause: '정릉3동주민센터앞→청덕초등학교입구 구간', slowest: { kmh: 6 }, kmh: 8.8 });
  assert.deepEqual([sect['가장 느린 도로'], sect['느린 정도']], ['정릉3동주민센터앞~청덕초등학교입구 구간', '걷는 속도 수준으로 느림']);
  const none = buildFacts({ no: '1112', congestion: 'normal', cause: null, slowest: { kmh: 15 }, kmh: 17.6 });
  assert.deepEqual(none, { '막힘 정도': '보통', '가장 느린 도로': null, '느린 정도': '조금 느림', 날씨: null, '주변 돌발정보': [] });
  // 긴 공사 이름은 30자 안쪽(낱말 단위)으로
  const long = buildFacts(TRIP, { incidents: { items: [{ ...WORK, title: '탄천나들목 및 봉은교 구조개선공사 및 하부 보수보강 공사 구간 통제' }] } });
  assert.ok(long['주변 돌발정보'][0].이름.length <= 30);
  assert.equal(long['주변 돌발정보'][0].이름, '탄천나들목 및 봉은교 구조개선공사 및 하부 보수보강');
});

test('근거 있음: 느린 도로 · 날씨 · 진행 중 돌발 중 하나라도. 원인 낱말은 날씨 + 진행 중 돌발 종류', () => {
  assert.equal(hasEvidence(facts()), true);
  assert.equal(hasEvidence(facts({ '가장 느린 도로': null, 날씨: null, '주변 돌발정보': [] })), false);
  assert.equal(hasEvidence(facts({ '가장 느린 도로': null, 날씨: null })), true);
  assert.equal(hasEvidence(facts({ '가장 느린 도로': null, 날씨: null, '주변 돌발정보': [{ 종류: '공사', 시점: '예정' }] })), false);
  assert.equal(hasEvidence(null), false);
  assert.deepEqual(causeWords(facts({ '주변 돌발정보': [{ 종류: '공사', 시점: '진행 중' }, { 종류: '공사', 시점: '진행 중' }, { 종류: '집회 · 행사', 시점: '진행 중' }] })), ['비', '공사', '집회·행사']);
});

test('기본 안내 문장: 숫자 없이 · 조사(이/가) 맞춤 · 근거 없으면 고정 문장', () => {
  assert.equal(ruleText(facts()), '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.');
  assert.equal(ruleText(facts({ 날씨: null, '주변 돌발정보': [] })), '정릉로가 막혀요. 특이 원인은 확인되지 않았어요.');
  assert.equal(ruleText(facts({ '가장 느린 도로': '정릉로9길', 날씨: '눈', '주변 돌발정보': [] })), '정릉로9길이 막혀요. 눈 영향일 수 있어요.');
  assert.equal(ruleText(facts({ '가장 느린 도로': '청덕초등학교입구~국민대학교앞 구간' })), '청덕초등학교입구~국민대학교앞 구간이 막혀요. 비 · 공사 영향일 수 있어요.');
  assert.equal(ruleText(facts({ '가장 느린 도로': '마을버스2', 날씨: null, '주변 돌발정보': [] })), '마을버스2가 막혀요. 특이 원인은 확인되지 않았어요.');
  assert.equal(ruleText(facts({ '가장 느린 도로': null })), '버스가 느리게 달리고 있어요. 비 · 공사 영향일 수 있어요.');
  assert.equal(ruleText(facts({ '가장 느린 도로': null, 날씨: null, '주변 돌발정보': [] })), NO_CAUSE_TEXT);
  assert.equal(NO_CAUSE_TEXT, '특이 지연 원인은 확인되지 않았어요.');
});

test('AI 문장 검사: 첫 줄 · 따옴표/머리말 정리 · 마침표 보충', () => {
  assert.deepEqual(cleanAiText('"정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요."', facts()), { ok: true, text: '정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.' });
  assert.deepEqual(cleanAiText('출력: **정릉로가 막혀요**\n둘째 줄', facts()), { ok: true, text: '정릉로가 막혀요.' });
  assert.deepEqual(cleanAiText('왜 늦나요? 정릉로가 막혀요.', facts()), { ok: true, text: '정릉로가 막혀요.' });
  assert.deepEqual(cleanAiText(NO_CAUSE_TEXT, facts({ '가장 느린 도로': null, 날씨: null, '주변 돌발정보': [] })), { ok: true, text: NO_CAUSE_TEXT });
});

test('AI 문장 검사: 숫자 · 사실에 없는 원인 · 너무 김 · 빈 응답 · 한국어 아님 → 버림', () => {
  const f = facts({ 날씨: null, '주변 돌발정보': [] }); // 정릉로만 확인됨
  assert.deepEqual(cleanAiText('정릉로가 막혀 11분 늦어요.', f), { ok: false, why: 'number' });
  assert.deepEqual(cleanAiText('정릉로가 막혀 １１분 늦어요.', f), { ok: false, why: 'number' });
  for (const s of ['비 때문에 정릉로가 막혀요.', '빗길에 정릉로가 막혀요.', '정릉로 사고로 막혀요.', '정릉로 공사 때문이에요.', '근처 집회 영향이에요.',
    '눈이 와서 막혀요.', '출근 시간이라 막혀요.', '신호 문제로 막혀요.', '차량 고장으로 막혀요.']) {
    assert.deepEqual(cleanAiText(s, f), { ok: false, why: 'ungrounded' }, s);
  }
  assert.deepEqual(cleanAiText('정릉로가 막혀요. '.repeat(8), f), { ok: false, why: 'long' });
  assert.deepEqual(cleanAiText('', f), { ok: false, why: 'empty' });
  assert.deepEqual(cleanAiText('```\n\n```', f), { ok: false, why: 'empty' });
  assert.deepEqual(cleanAiText('The road is congested.', f), { ok: false, why: 'format' });
  // '비'가 든 다른 낱말은 원인으로 보지 않음
  assert.equal(cleanAiText('정릉로가 비슷하게 막혀요.', f).ok, true);
});

test('AI 문장 검사: 사실에 있는 원인 · 이름에 든 숫자(정릉3동 · 정릉로9길)는 통과, 예정된 돌발은 원인으로 못 씀', () => {
  assert.equal(cleanAiText('정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.', facts()).ok, true); // v2.2.6 예전 '…겹쳐 막혀요'는 v226.test.js(원인을 단정)
  assert.equal(cleanAiText('정릉로 하수관 정비공사 영향일 수 있어요.', facts({ 날씨: null })).ok, true);
  const sect = facts({ '가장 느린 도로': '정릉3동주민센터앞~청덕초등학교입구 구간', 날씨: null, '주변 돌발정보': [] });
  assert.equal(cleanAiText('정릉3동주민센터앞~청덕초등학교입구 구간이 많이 막혀요.', sect).ok, true);
  assert.equal(cleanAiText('정릉3동주민센터앞에서 청덕초등학교입구 사이가 막혀요.', sect).ok, true);
  assert.equal(cleanAiText('정릉3동 쪽이 3배 막혀요.', sect).ok, false, '이름 밖의 숫자는 안 됨');
  assert.equal(cleanAiText('정릉로9길이 막혀요.', facts({ '가장 느린 도로': '정릉로9길', 날씨: null, '주변 돌발정보': [] })).ok, true);
  const soon = facts({ 날씨: null, '주변 돌발정보': [{ 종류: '집회 · 행사', 이름: '거리 행사', 위치: '국민대 근처', 시점: '예정' }] });
  assert.deepEqual(cleanAiText('국민대 근처 행사 때문에 막혀요.', soon), { ok: false, why: 'ungrounded' });
  // 공사 이름 속 '사고'로 사고를 지어내지 못함
  const tricky = facts({ 날씨: null, '주변 돌발정보': [{ 종류: '공사', 이름: '사고 다발 구간 개선공사', 위치: '경로 위', 시점: '진행 중' }] });
  assert.equal(cleanAiText('사고 다발 구간 개선공사 영향일 수 있어요.', tricky).ok, true);
  assert.deepEqual(cleanAiText('정릉로 사고로 막혀요.', tricky), { ok: false, why: 'ungrounded' });
});
