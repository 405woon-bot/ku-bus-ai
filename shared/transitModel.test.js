import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockLive, EXAMPLE_ROUTES } from './transitModel.js';
import { toMin } from './time.js';
test('정릉로 정체 예시: 08:20에 171번 평소 12분 → 20분, 1112번 영향 없음', () => {
  const r = mockLive(EXAMPLE_ROUTES, 'jeongneung', toMin('08:20'));
  const m = Object.fromEntries(r.routes.map((x) => [x.no, x.liveMin]));
  assert.equal(m['171'], 20); assert.equal(m['1112'], 13); assert.equal(r.cause, '정릉로');
});
test('평소 시나리오는 지연 없음', () => {
  const r = mockLive(EXAMPLE_ROUTES, 'normal', toMin('08:20'));
  assert.ok(r.routes.every((x) => x.liveMin === x.usualMin)); assert.equal(r.cause, null);
});
