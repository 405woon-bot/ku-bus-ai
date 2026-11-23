// v2.2.2 사용자 ID 점검: 새 ID는 암호학적 난수 32자 · 예전 8자 ID는 그대로 · 저장 공간이 막혀도 'demo'로 떨어지지 않음
//   (localStorage · 쿠키 자리에 가짜 저장소를 넣어 '막힘 · 읽기만 됨 · 다시 열기'를 흉내 냄)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID_RE, LONG_ID_RE, SHARED_ID, createUserIdSource, idKind, newUserId } from './userId.js';

const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
/** 가짜 저장소: mode 'ok'(읽기·쓰기) | 'blocked'(둘 다 예외) | 'readonly'(읽기만, 쓰기는 예외 — 예전 Safari 개인 정보 보호 모드) */
function slot(mode = 'ok', value = null) {
  const s = { value, writes: 0 };
  s.get = () => { if (mode === 'blocked') throw new Error('SecurityError'); return s.value; };
  s.set = (v) => { if (mode !== 'ok') throw new Error('QuotaExceededError'); s.writes++; s.value = v; };
  return s;
}
const source = (local, cookie) => createUserIdSource({ local, cookie, random: rnd });

test('새 ID: u + 32자(0-9 a-f, 난수 128비트) · 받은 난수 그대로 · 난수가 없거나 실패해도 같은 모양', () => {
  assert.equal(newUserId(() => Uint8Array.from({ length: 16 }, (_, i) => i * 17)), 'u00112233445566778899aabbccddeeff');
  const many = new Set(Array.from({ length: 2000 }, () => newUserId(rnd)));
  assert.equal(many.size, 2000, '2000개가 모두 다름');
  assert.ok([...many].every((id) => LONG_ID_RE.test(id) && ID_RE.test(id)), '서버 · 쿠키가 받는 모양(64자 이하)');
  assert.match(newUserId(() => { throw new Error('no crypto'); }), LONG_ID_RE, '난수 함수가 실패하면 Math.random으로라도 32자');
  assert.match(newUserId(() => new Uint8Array(4)), LONG_ID_RE, '난수가 모자라도');
  assert.match(newUserId(), LONG_ID_RE);
});

test('ID 종류(서버는 개수만 셈): 새 ID · 예전 8자 · 공용 demo · 그 밖', () => {
  assert.equal(idKind(newUserId(rnd)), 'long');
  assert.equal(idKind('u3k9x2m1p'), 'short');
  assert.equal(idKind(SHARED_ID), 'demo');
  assert.deepEqual(['e2e1732000000', 'u21', '', null].map(idKind), ['other', 'short', 'other', 'other']);
});

test('예전 8자 ID가 있는 기기: 바꾸지 않고 그대로 씀(기존 기록 · 알림 구독 유지) · 쿠키는 페이지마다 한 번', () => {
  const local = slot('ok', 'u3k9x2m1p'), cookie = slot('ok');
  const ids = source(local, cookie);
  assert.deepEqual([ids.get(), ids.get(), ids.get()], ['u3k9x2m1p', 'u3k9x2m1p', 'u3k9x2m1p']);
  assert.deepEqual([local.value, local.writes], ['u3k9x2m1p', 0], '저장된 값을 덮어쓰지 않음');
  assert.deepEqual([cookie.value, cookie.writes], ['u3k9x2m1p', 1]);
  assert.deepEqual(ids.info(), { id: 'u3k9x2m1p', from: 'local', localSaved: true, kind: 'short' });
  // 모양이 특이한 예전 값(테스트 · 다른 버전)도 그대로
  assert.equal(source(slot('ok', 'e2e1732000000'), slot()).get(), 'e2e1732000000');
});

test('처음 여는 기기: 새 긴 ID를 저장 공간 · 쿠키에 남기고 같은 페이지에서는 늘 같은 값', () => {
  const local = slot('ok'), cookie = slot('ok');
  const ids = source(local, cookie);
  const id = ids.get();
  assert.match(id, LONG_ID_RE);
  assert.deepEqual([ids.get(), local.value, cookie.value, cookie.writes], [id, id, id, 1]);
  assert.equal(ids.info().from, 'new');
  // 다시 열기(새 페이지) → 저장 공간의 값
  assert.equal(source(local, slot('ok')).get(), id);
});

test('저장 공간은 비었는데 쿠키가 있으면(아이폰 홈 화면 앱으로 옮겨진 경우) 쿠키의 사용자로 이어 감 — 예전과 같음', () => {
  const local = slot('ok'), ids = source(local, slot('ok', 'u3k9x2m1p'));
  assert.deepEqual([ids.get(), local.value, ids.info().from], ['u3k9x2m1p', 'u3k9x2m1p', 'cookie']);
});

test("저장 공간이 막힌 기기(쿠키는 됨): 'demo'가 아니라 이 기기만의 ID → 다시 열어도 쿠키로 같은 사용자", () => {
  const cookie = slot('ok');
  const a = source(slot('blocked'), cookie);
  const id = a.get();
  assert.notEqual(id, SHARED_ID);
  assert.match(id, LONG_ID_RE);
  assert.deepEqual([a.get(), a.info().localSaved, cookie.value], [id, false, id]);
  assert.equal(source(slot('blocked'), cookie).get(), id, '새로고침해도 같은 사용자(쿠키)');
  // 다른 기기(쿠키가 다름)는 다른 사용자 — 예전에는 둘 다 'demo'
  assert.notEqual(source(slot('blocked'), slot('ok')).get(), id);
});

test("저장 공간 · 쿠키가 모두 막힌 기기: 이 페이지에서만 쓰는 임시 ID — 페이지 안에서는 같고, 기기 · 페이지끼리는 다름(절대 'demo' 아님)", () => {
  const a = source(slot('blocked'), slot('blocked')), b = source(slot('blocked'), slot('blocked'));
  const ida = a.get(), idb = b.get();
  assert.ok(LONG_ID_RE.test(ida) && LONG_ID_RE.test(idb));
  assert.notEqual(ida, idb);
  assert.deepEqual([a.get(), a.get(), b.get()], [ida, ida, idb], '같은 페이지 안에서는 요청마다 같은 ID');
  assert.deepEqual(a.info(), { id: ida, from: 'new', localSaved: false, kind: 'long' });
  assert.equal(a.hasLocal(), false);
});

test("읽기만 되고 쓰기는 예외(예전 Safari 개인 정보 보호 모드): 예전 코드는 'demo'를 돌려줬음 → 이제 이 기기만의 ID", () => {
  const local = slot('readonly'), cookie = slot('ok');
  const ids = source(local, cookie);
  const id = ids.get();
  assert.ok(LONG_ID_RE.test(id) && id !== SHARED_ID);
  assert.deepEqual([ids.get(), ids.info().localSaved, local.value, cookie.value], [id, false, null, id]);
  assert.equal(source(slot('readonly'), cookie).get(), id, '다시 열면 쿠키로 같은 사용자');
});

test("이 기기에 'demo'가 저장돼 있으면(예전 공용 사용자를 이어받은 경우) 쓰지 않고 새 ID로 바꿈 · 쿠키의 'demo'도 무시", () => {
  const local = slot('ok', SHARED_ID);
  const ids = source(local, slot('ok', SHARED_ID));
  const id = ids.get();
  assert.match(id, LONG_ID_RE);
  assert.equal(local.value, id, "저장 공간의 'demo'를 새 ID로 바꿈");
  assert.equal(source(slot('ok', SHARED_ID), slot()).hasLocal(), false);
});

test("이어받기로 받은 ID: 모양이 맞으면 저장 · 'demo'와 이상한 값은 받지 않음 · 저장 공간이 막혀도 이 페이지에서는 받은 ID로", () => {
  const local = slot('ok'), cookie = slot('ok');
  const ids = source(local, cookie);
  ids.get(); // 받기 전에 다른 요청이 먼저 새 ID를 만든 경우에도
  assert.equal(ids.set('u3k9x2m1p'), true);
  assert.deepEqual([ids.get(), local.value, cookie.value, ids.info().from], ['u3k9x2m1p', 'u3k9x2m1p', 'u3k9x2m1p', 'handoff']);
  for (const bad of [SHARED_ID, '', 'a b', 'x'.repeat(65), null]) assert.equal(ids.set(bad), false, String(bad));
  assert.equal(ids.get(), 'u3k9x2m1p', '거절한 값으로 바뀌지 않음');
  // 막힌 기기: 예전 코드는 받은 뒤에도 'demo'를 돌려줬음 → 이제 받은 ID
  const blocked = source(slot('blocked'), slot('blocked'));
  const long = newUserId(rnd);
  assert.equal(blocked.set(long), true);
  assert.deepEqual([blocked.get(), blocked.get(), blocked.info().localSaved], [long, long, false]);
});

test('저장 공간에 사용자가 있는지(이어받기 여부 판단): 있으면 true · 비었거나 막혔으면 false — 예전과 같음', () => {
  assert.equal(source(slot('ok', 'u3k9x2m1p'), slot()).hasLocal(), true);
  assert.equal(source(slot('ok'), slot('ok', 'u3k9x2m1p')).hasLocal(), false, '쿠키만 있으면 이어받기 코드를 씀(예전과 같음)');
  assert.equal(source(slot('blocked'), slot()).hasLocal(), false);
});
