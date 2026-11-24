// v2.2.6 점검: ① 심야 판단(서울 23:00 ~ 04:30 전) · 근처 정류장을 못 찾았을 때 문구 / ② AI 문장이 원인을 결과에 이어 단정하면 버림(기본 안내는 늘 통과)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LATE_NIGHT, NIGHT_NEARBY_TEXT, isLateNight, nearbyNoneText } from './transitPlan.js';
import { NO_CAUSE_TEXT, cleanAiText, hasCausalLink, josa, josaWa, ruleText } from './explain.js';

const facts = (o = {}) => ({ '막힘 정도': '혼잡', '가장 느린 도로': '정릉로', '느린 정도': '걷는 속도 수준으로 느림', 날씨: '비',
  '주변 돌발정보': [{ 종류: '공사', 이름: '하수관 정비공사', 위치: '경로 위', 시점: '진행 중' }], ...o });

test('심야: 서울 시각 23:00부터 04:30 전까지(경계 포함 · 숫자가 아니면 아님)', () => {
  assert.deepEqual([LATE_NIGHT.fromMin, LATE_NIGHT.toMin], [1380, 270]);
  const at = (h, m) => h * 60 + m;
  assert.deepEqual([at(22, 59), at(23, 0), at(23, 40), at(0, 0), at(2, 15), at(4, 29) + 0.99, at(4, 30), at(8, 5), at(12, 0)].map(isLateNight),
    [false, true, true, true, true, true, false, false, false]);
  assert.deepEqual([isLateNight(NaN), isLateNight(null), isLateNight(undefined)], [false, false, false]);
});

test('근처 국민대행 정류장을 못 찾았을 때 문구: 심야 표시면 운행이 끝났을 수 있다고(단정하지 않음) · 아니면 지금 그대로', () => {
  assert.equal(nearbyNoneText({ ok: true, stops: [], radiusM: 400 }), '출발지 400m 안에 국민대로 바로 가는 버스 정류장이 없어요');
  assert.equal(nearbyNoneText({ ok: true, stops: [] }), '출발지 400m 안에 국민대로 바로 가는 버스 정류장이 없어요');
  assert.equal(nearbyNoneText({ ok: false, reason: 'api', stops: [] }), '근처 버스 정류장을 확인하지 못했어요');
  assert.equal(nearbyNoneText({ ok: true, stops: [], radiusM: 400, night: true }), NIGHT_NEARBY_TEXT);
  assert.equal(nearbyNoneText({ ok: false, reason: 'api', stops: [], night: true }), NIGHT_NEARBY_TEXT);
  assert.equal(nearbyNoneText(null), '');
  assert.equal(NIGHT_NEARBY_TEXT, '버스 운행이 끝난 시간이라 근처 국민대행 정류장을 확인하기 어려울 수 있어요. 아침에 다시 찾아 주세요.');
  assert.ok(/수 있어요/.test(NIGHT_NEARBY_TEXT) && !/없어요/.test(NIGHT_NEARBY_TEXT), '없다고 단정하지 않음');
});

test('원인을 결과에 잇는 말: 때문 · 겹쳐 · -서 · 니까 · 원인 + 로 · 영향으로 → 있음(가능성으로 끝나도) / 따로 말하면 · 에서 · 이름 속 글자 → 없음', () => {
  const f = facts();
  for (const s of ['정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.', '정릉로에 비가 와서 버스가 느려요.', '비 때문에 정릉로가 막혀요.', '공사로 정릉로가 막혀요.',
    '비 영향으로 버스가 느려졌을 수 있어요.', '공사가 있어서 막혀요.', '비가 오니까 막혀요.', '비가 와서 그럴 수 있어요.', '공사 탓에 느려요.',
    '비로 인해 막혀요.', '정릉로가 막혀서 늦어요.', '그래서 버스가 느려요.', '비가 오면서 막혀요.', '공사 중이라서 막혀요.', '공사 영향을 받아 느려요.']) {
    assert.equal(hasCausalLink(s, f), true, s);
  }
  for (const s of ['정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.', '정릉로에서 버스가 걷는 속도만큼 느려요.', '정릉로가 조금 막혀요. 특이 원인은 확인되지 않았어요.',
    '버스가 평소보다 느려요. 비 영향일 수 있어요.', '정릉로에서 버스가 서서히 느려지고 있어요.', '비로소 정릉로가 풀리고 있어요.', NO_CAUSE_TEXT]) {
    assert.equal(hasCausalLink(s, f), false, s);
  }
  // 사실에 든 이름(도로 · 구간 · 돌발 이름)은 검사에서 뺌: '성북경찰서' · '공사로 인한 통제'
  const named = facts({ '가장 느린 도로': '성북경찰서~국민대학교앞 구간', '주변 돌발정보': [{ 종류: '공사', 이름: '공사로 인한 통제', 위치: '경로 위', 시점: '진행 중' }] });
  assert.equal(hasCausalLink('성북경찰서~국민대학교앞 구간이 막혀요. 공사로 인한 통제 영향일 수 있어요.', named), false);
  assert.equal(hasCausalLink('성북경찰서~국민대학교앞 구간이 공사로 막혀요.', named), true, '이름 밖에서 원인 + 로');
});

test('AI 문장 검사(cleanAiText): 원인을 단정하면 why causal · 지어낸 원인은 예전처럼 ungrounded가 먼저', () => {
  assert.deepEqual(cleanAiText('정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.', facts()), { ok: false, why: 'causal' }, '예전 지시문 예시 문장');
  assert.deepEqual(cleanAiText('"비가 와서 버스가 느려요."', facts()), { ok: false, why: 'causal' });
  assert.deepEqual(cleanAiText('비 때문에 정릉로가 막혀요.', facts({ 날씨: null, '주변 돌발정보': [] })), { ok: false, why: 'ungrounded' }, '사실에 없는 원인은 ungrounded');
  assert.deepEqual(cleanAiText('정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.', facts()), { ok: true, text: '정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.' });
});

test('기본 안내 문장(ruleText)은 어떤 사실 조합에서도 원인을 잇지 않고 AI 문장 검사를 통과함', () => {
  const places = [null, '정릉로', '정릉3동주민센터앞~청덕초등학교입구 구간', '성북경찰서~국민대학교앞 구간', '정릉로9길'];
  const weathers = [null, '비', '눈', '소나기', '빗방울', '진눈깨비'];
  const incs = [[], [{ 종류: '공사', 이름: '하수관 정비공사', 위치: '경로 위', 시점: '진행 중' }],
    [{ 종류: '사고', 이름: '추돌사고', 위치: '국민대 근처', 시점: '진행 중' }, { 종류: '집회 · 행사', 이름: '거리 행사', 위치: '경로 위', 시점: '진행 중' }],
    [{ 종류: '집회 · 행사', 이름: '거리 행사', 위치: '국민대 근처', 시점: '예정' }]];
  let n = 0;
  for (const place of places) for (const wx of weathers) for (const inc of incs) {
    const f = facts({ '가장 느린 도로': place, '느린 정도': place ? '조금 느림' : '많이 느림', 날씨: wx, '주변 돌발정보': inc });
    const t = ruleText(f);
    assert.equal(hasCausalLink(t, f), false, t);
    assert.equal(cleanAiText(t, f).ok, true, t);
    n++;
  }
  assert.equal(n, 120);
});

test('조사: 이 · 가 / 와 · 과(받침 · 숫자 읽는 소리)', () => {
  assert.deepEqual([josa('정릉로'), josa('구간'), josa('마을버스2'), josa('7')], ['가', '이', '가', '이']);
  assert.deepEqual([josaWa('공사'), josaWa('눈'), josaWa('집회·행사'), josaWa('사고')], ['와', '과', '와', '와']);
});
