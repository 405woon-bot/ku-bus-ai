import { test } from 'node:test';
import assert from 'node:assert/strict';
import { causeFromSection, SLOW_KMH } from './corridors.js';
import { mainReason, reasonText } from './liveStatus.js';

test('정체 원인: 매핑표 도로명 → 노선 설정 corridorSeq → 정류장 이름, 15 km/h 이상은 정체 아님', () => {
  assert.equal(SLOW_KMH, 15);
  assert.equal(causeFromSection('171', { from: '청덕초등학교입구', to: '국민대학교앞', kmh: 8 }).text, '정릉로');
  assert.equal(causeFromSection('171', { from: '청덕초등학교 입구', to: '국민대학교앞', kmh: 8 }).road, '정릉로'); // 공백 차이 무시
  assert.equal(causeFromSection('7211', { from: 'A', to: 'B', kmh: 6, seq: 12 }, { corridor: '북악산로', corridorSeq: [10, 14] }).text, '북악산로');
  assert.equal(causeFromSection('7211', { from: 'A', to: 'B', kmh: 6, seq: 20 }, { corridor: '북악산로', corridorSeq: [10, 14] }).text, 'A→B 구간');
  assert.equal(causeFromSection('171', { from: 'A', to: 'B', kmh: 15 }), null);
});

test('폴백 이유: 사용자가 고칠 수 있는 이유 우선', () => {
  assert.equal(mainReason(['network', 'config', 'no-key']), 'no-key');
  assert.equal(mainReason(['network', 'quota']), 'quota');
  assert.equal(reasonText('config'), '승차 정류장 미설정');
});
