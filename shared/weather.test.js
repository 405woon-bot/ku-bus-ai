// 실행: node --test shared/weather.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { KU_GRID, PTY_TEXT, latLonToGrid, ncstBase, obsTime, parseRn1, prevBase, summarizeNcst, weatherText, wxHeadline, wxKind } from './weather.js';
import { KU_POINT, kstMs } from './incidents.js';
import { sampleNcstItems } from './samples/weatherSample.js';

const item = (category, obsrValue, baseTime = '0800') => ({ baseDate: '20261109', baseTime, category, nx: 60, ny: 128, obsrValue });

test('격자: 국민대(정릉동) → nx 60 · ny 128, 서울시청 → 60 · 127(공개 구현의 검증 값과 같음)', () => {
  assert.deepEqual(latLonToGrid(KU_POINT.lat, KU_POINT.lon), { nx: 60, ny: 128 });
  assert.deepEqual(latLonToGrid(37.6108, 126.9969), { nx: 60, ny: 128 }, '캠퍼스 가운데도 같은 격자');
  assert.deepEqual(latLonToGrid(37.6060, 127.0101), { nx: 60, ny: 128 }, '정릉시장');
  assert.deepEqual(latLonToGrid(37.5665, 126.9780), { nx: 60, ny: 127 });
  assert.deepEqual(KU_GRID, latLonToGrid(KU_POINT.lat, KU_POINT.lon));
});

test('발표 시각: 10분 전의 정시 → 자료가 없으면 한 시간 전(날짜가 바뀌어도)', () => {
  assert.deepEqual(ncstBase(kstMs('20261109', '0805')), { baseDate: '20261109', baseTime: '0700' });
  assert.deepEqual(ncstBase(kstMs('20261109', '0815')), { baseDate: '20261109', baseTime: '0800' });
  assert.deepEqual(ncstBase(kstMs('20261109', '0005')), { baseDate: '20261108', baseTime: '2300' });
  assert.deepEqual(prevBase({ baseDate: '20261109', baseTime: '0800' }), { baseDate: '20261109', baseTime: '0700' });
  assert.deepEqual(prevBase({ baseDate: '20261101', baseTime: '0000' }), { baseDate: '20261031', baseTime: '2300' });
});

test('1시간 강수량: 숫자 · 예보식 글 모두, 결측(±900)과 못 읽는 값은 null', () => {
  assert.deepEqual(['0', '1.5', ' 12 ', '강수없음', '1mm 미만', '1.0mm 미만', '30.0~50.0mm', '50.0mm 이상', '-998.9', '999', '', null, 'abc'].map(parseRn1),
    [0, 1.5, 12, 0, 0.5, 0.5, 30, 50, null, null, null, null, null]);
});

test('요약: 강수형태 · 강수량 · 기온, 비/눈이면 wet, 결측은 null', () => {
  const w = summarizeNcst([item('PTY', '1'), item('RN1', '1.5'), item('T1H', '7.2'), item('REH', '92'), item('WSD', '2.1'), item('UUU', '-1.2')]);
  assert.deepEqual([w.pty, w.ptyText, w.rn1Mm, w.t1h, w.reh, w.wsd, w.wet, w.baseDate, w.baseTime], [1, '비', 1.5, 7.2, 92, 2.1, true, '20261109', '0800']);
  assert.equal(new Date(w.obsAt).toISOString(), '2026-11-08T23:00:00.000Z');
  assert.equal(w.raw.UUU, '-1.2');
  assert.equal(weatherText(w), '비 · 1시간 1.5mm');
  const dry = summarizeNcst([item('PTY', '0'), item('RN1', '0'), item('T1H', '-999')]);
  assert.deepEqual([dry.wet, dry.t1h, weatherText(dry)], [false, null, '강수 없음']);
  const snow = summarizeNcst([item('PTY', '3'), item('RN1', '0')]);
  assert.deepEqual([snow.wet, weatherText(snow)], [true, '눈']);
  assert.equal(summarizeNcst([item('PTY', '9')]).ptyText, '알 수 없음');
  assert.equal(summarizeNcst([item('PTY', '0')]).rn1Mm, null, 'RN1이 없어도 강수형태만으로 요약');
});

test('형식이 예상과 다르면 null(날씨를 보여 주지 않음)', () => {
  assert.equal(summarizeNcst([item('T1H', '7.2')]), null);
  assert.equal(summarizeNcst([]), null);
  assert.equal(summarizeNcst(null), null);
  assert.equal(summarizeNcst([{ category: 'PTY', obsrValue: '비' }, { category: 'RN1', obsrValue: '' }]), null);
});

test('예시 날씨(실시간 아님): 지금 발표 시각 · 국민대 격자 · 비/눈/맑음', () => {
  const now = kstMs('20261109', '0812');
  const rain = summarizeNcst(sampleNcstItems(now));
  assert.deepEqual([rain.ptyText, rain.rn1Mm, rain.baseTime, rain.wet], ['비', 1.5, '0800', true]);
  assert.equal(summarizeNcst(sampleNcstItems(now, 'clear')).wet, false);
  assert.equal(PTY_TEXT[summarizeNcst(sampleNcstItems(now, 'snow')).pty], '눈');
});

test('화면 문구: 관측 시각 · 강수 종류 · 한 줄 제목 (실제 응답 값 포함)', () => {
  const real = summarizeNcst(Object.entries({ PTY: '0', REH: '65', RN1: '0', T1H: '11.7', UUU: '-1.8', VEC: '52', VVV: '-1.4', WSD: '2.4' })
    .map(([category, obsrValue]) => ({ baseDate: '20261117', baseTime: '0000', category, nx: 60, ny: 128, obsrValue })));
  assert.deepEqual([real.wet, real.t1h, real.reh, obsTime(real), weatherText(real)], [false, 11.7, 65, '00:00', '강수 없음']);
  const drizzle = summarizeNcst([item('PTY', '0'), item('RN1', '0.5')]);
  assert.deepEqual([drizzle.wet, wxKind(drizzle), wxHeadline(drizzle), obsTime(drizzle)], [true, '비', '비 오는 중 · 1시간 0.5mm', '08:00']);
  const snow = summarizeNcst([item('PTY', '3', '0700'), item('RN1', '0', '0700')]);
  assert.deepEqual([wxKind(snow), wxHeadline(snow), obsTime(snow)], ['눈', '눈 오는 중', '07:00']);
  assert.equal(obsTime({ baseTime: '' }), '');
});
