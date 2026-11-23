// v2.2.3 위치 저장 정밀도 점검: GPS 출발지만 약 100m 칸(소수 셋째 자리)으로 · 역 · 정류장은 그대로 · 몇 번을 해도 같음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COARSE_DIGITS, coarse, coarseOrigin, gpsKey, isCoarse, isPreciseGps } from './geoPrivacy.js';
import { distanceM } from './transitPlan.js';

const GPS = { name: 'GPS로 고른 위치', lat: 37.557527, lon: 126.923778, kind: 'gps', arsId: '' };

test('칸 반올림: 소수 셋째 자리 · 다시 해도 같음 · 움직인 거리는 최대 약 70m(서울)', () => {
  assert.equal(COARSE_DIGITS, 3);
  assert.deepEqual([coarse(37.557527), coarse(126.923778), coarse(37.5574999), coarse(127.0005001)], [37.558, 126.924, 37.557, 127.001]);
  for (const v of [37.557527, 126.923778, 37.6109, 127.0]) assert.equal(coarse(coarse(v)), coarse(v), '두 번 해도 같음');
  assert.deepEqual([isCoarse(37.558), isCoarse(37.5575), isCoarse('x')], [true, false, false]);
  // 서울 근처 여러 점: 반올림으로 움직인 거리가 칸 대각선의 절반(약 71m)을 넘지 않음
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const lat = 37.4 + (i * 0.0013337) % 0.3, lon = 126.8 + (i * 0.0021131) % 0.4;
    worst = Math.max(worst, distanceM({ x: lon, y: lat }, { x: coarse(lon), y: coarse(lat) }));
  }
  assert.ok(worst > 40 && worst < 72, `가장 많이 움직인 거리 ${worst.toFixed(1)}m`);
});

test('GPS 출발지만 칸으로: 위도 · 경도만 바뀌고 다른 값은 그대로 · 역 · 정류장과 이미 칸인 값은 같은 객체', () => {
  const c = coarseOrigin(GPS);
  assert.deepEqual(c, { ...GPS, lat: 37.558, lon: 126.924 });
  assert.notEqual(c, GPS, '원래 객체는 바꾸지 않음');
  assert.equal(GPS.lat, 37.557527);
  assert.equal(coarseOrigin(c), c, '이미 칸이면 그대로');
  const stop = { name: '홍대입구역', lat: 37.557527, lon: 126.923778, kind: 'stop', arsId: '14001' };
  assert.equal(coarseOrigin(stop), stop, '이름으로 고른 역 · 정류장은 공개 좌표라 그대로');
  for (const x of [null, undefined, {}, { kind: 'gps' }, { kind: 'gps', lat: 'a', lon: 1 }]) assert.equal(coarseOrigin(x), x);
  assert.deepEqual([isPreciseGps(GPS), isPreciseGps(c), isPreciseGps(stop), isPreciseGps(null)], [true, false, false, false]);
});

test('GPS 검색 결과 키: 같은 칸이면 같은 키 · 예전(소수 넷째 자리) 키와 모양이 다름', () => {
  assert.equal(gpsKey(37.557527, 126.923778), 'g:37.558,126.924');
  assert.equal(gpsKey(37.5578, 126.9241), 'g:37.558,126.924', '같은 칸');
  assert.equal(gpsKey(37.6, 127), 'g:37.600,127.000');
  assert.notEqual(gpsKey(37.5575, 126.9238), `g:${(37.5575).toFixed(4)},${(126.9238).toFixed(4)}`);
});
