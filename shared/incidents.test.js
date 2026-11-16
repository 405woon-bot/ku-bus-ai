// 실행: node --test shared/incidents.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { distToPath, fmtKst, headline, kstMs, latLonToTm, matchIncidents, normalizeAcc, parseAccText, periodText, statusText, tmToLatLon, whereText } from './incidents.js';
import { sampleIncidentRows } from './samples/incidentSample.js';

// 실제 응답에서 확인한 한 건(서울 열린데이터광장 AccInfo)
const REAL_ROW = {
  acc_id: '1071788', occr_date: '20260407', occr_time: '1000', exp_clr_date: '20270301', exp_clr_time: '000000', acc_type: 'A04', acc_dtype: '04B01',
  link_id: '1220031600', grs80tm_x: '206076.7132692197', grs80tm_y: '446245.6950463236',
  acc_info: '탄천나들목 및 봉은교 구조개선공사-일시 : 26.4.7(화)10:00~27.2.28(일) 23:59-장소 : 봉은교-통제 : 양방향 전면통제', acc_road_code: '009',
};
const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const NOW = kstMs('20261109', '0810'); // 월 08:10(서울)
const PATH = [{ lat: 37.60785, lon: 127.0022, name: '고려대사범대학부속고등학교' }, { lat: 37.6084955, lon: 127.0002507, name: '청덕초등학교입구' }, { lat: 37.6106, lon: 126.997, name: '국민대학교앞' }];

test('좌표: GRS80 중부원점 TM(EPSG:5181) ↔ 위경도 — pyproj 값과 같음', () => {
  const p = tmToLatLon(206076.7132692197, 446245.6950463236); // pyproj: 37.51567164569313, 127.06873568392719 (봉은교)
  near(p.lat, 37.5156716457, 1e-7); near(p.lon, 127.0687356839, 1e-7);
  const t = latLonToTm(37.6106, 126.997); // pyproj: 199735.11543004063, 456779.4092231473
  near(t.x, 199735.11543, 0.01); near(t.y, 456779.40922, 0.01);
  const back = tmToLatLon(t.x, t.y);
  near(back.lat, 37.6106, 1e-8); near(back.lon, 126.997, 1e-8);
  assert.equal(tmToLatLon('', ''), null);
  assert.equal(tmToLatLon(0, 0), null);
});

test('시각: YYYYMMDD + HHMM/HHMMSS(서울) → epoch, 짧은 표시', () => {
  assert.equal(new Date(kstMs('20260407', '1000')).toISOString(), '2026-04-07T01:00:00.000Z');
  assert.equal(new Date(kstMs('20270301', '000000')).toISOString(), '2027-02-28T15:00:00.000Z');
  assert.equal(new Date(kstMs('20261109', '930')).toISOString(), '2026-11-09T00:30:00.000Z');
  assert.equal(kstMs('', '1000'), null);
  assert.equal(kstMs('00000000', '0000'), null);
  assert.equal(kstMs('20261340', '1000'), null);
  assert.equal(fmtKst(kstMs('20261109', '1000'), NOW), '10:00');
  assert.equal(fmtKst(kstMs('20261103', '0900'), NOW), '11.3 09:00');
  assert.equal(fmtKst(kstMs('20270228', '2359'), NOW), '27.2.28');
});

test('acc_info 글 나누기(제목 · 일시 · 장소 · 통제), 형식이 다르면 전체가 제목', () => {
  assert.deepEqual(parseAccText(REAL_ROW.acc_info), { title: '탄천나들목 및 봉은교 구조개선공사', period: '26.4.7(화)10:00~27.2.28(일) 23:59', place: '봉은교', control: '양방향 전면통제' });
  assert.deepEqual(parseAccText('강남대로-테헤란로 교차로 사고'), { title: '강남대로-테헤란로 교차로 사고', period: '', place: '', control: '' });
  assert.equal(parseAccText('').title, '');
});

test('행 정리: 실제 응답 한 건 → 종류 · 위치 · 시각 · 글', () => {
  const n = normalizeAcc(REAL_ROW);
  assert.equal(n.type, 'A04'); assert.equal(n.label, '공사'); assert.equal(n.kind, 'work');
  near(n.lat, 37.515672, 1e-6); near(n.lon, 127.068736, 1e-6);
  assert.equal(n.title, '탄천나들목 및 봉은교 구조개선공사'); assert.equal(n.control, '양방향 전면통제');
  assert.equal(n.startAt, kstMs('20260407', '1000')); assert.equal(n.endAt, kstMs('20270301', '000000'));
  assert.equal(normalizeAcc({ ...REAL_ROW, acc_type: 'A02' }), null, '차량고장(A02)은 보여 주지 않음');
  assert.equal(normalizeAcc({ ...REAL_ROW, grs80tm_x: '' }), null, '좌표가 없으면 뺌');
  assert.equal(normalizeAcc({ ...REAL_ROW, acc_info: '' }).title, '공사');
});

test('경로까지 거리: 선분 위 · 끝점 바깥 · 가장 가까운 정류장', () => {
  const mid = { lat: (PATH[1].lat + PATH[2].lat) / 2, lon: (PATH[1].lon + PATH[2].lon) / 2 };
  const d = distToPath(mid, PATH);
  assert.ok(d.distM < 1, `${d.distM}`);
  assert.ok([1, 2].includes(d.idx));
  const off = distToPath({ lat: 37.6140, lon: 126.9925 }, PATH);
  near(off.distM, 548, 5); assert.equal(off.idx, 2);
  assert.equal(distToPath(mid, []).distM, Infinity);
});

test('매칭: 경로 300m 안 → 경로 위, 국민대 1km 안 → 국민대 근처, 먼 곳 · 끝난 것 · 3시간 뒤 · 다른 종류는 뺌', () => {
  const rows = [
    ...sampleIncidentRows(NOW), // 경로 위 공사 · 국민대 근처 행사(10:00) · 봉은교(멀리) · 차량고장(A02)
    { ...sampleIncidentRows(NOW)[0], acc_id: 'OLD', acc_type: 'A01', occr_date: '20261108', occr_time: '0700', exp_clr_date: '20261108', exp_clr_time: '090000' },
    { ...sampleIncidentRows(NOW)[1], acc_id: 'LATER', occr_date: '20261109', occr_time: '1300', exp_clr_date: '20261109', exp_clr_time: '150000' },
  ];
  const items = matchIncidents(rows.map(normalizeAcc).filter(Boolean), { trips: [{ no: '171', path: PATH }, { no: '1213', path: PATH }, { no: '7211', path: [] }], nowMs: NOW });
  assert.deepEqual(items.map((x) => [x.id, x.where, x.status]), [['SAMPLE-1', 'route', 'active'], ['SAMPLE-2', 'campus', 'soon']]);
  const [work, ev] = items;
  assert.deepEqual(work.routes, ['171', '1213']);
  assert.equal(work.nearStop, '청덕초등학교입구');
  assert.equal(headline(work), '경로 위 공사 중'); assert.equal(whereText(work), '171 · 1213 경로 위');
  assert.equal(headline(ev), '국민대 근처 집회 · 행사 예정'); assert.equal(whereText(ev), '국민대에서 약 550m');
  assert.equal(statusText(ev, NOW), '10:00부터 예정'); assert.equal(periodText(ev, NOW), '10:00 ~ 12:00');
  // 경로 정보가 없으면(예시 버스) 국민대 근처로만
  const campusOnly = matchIncidents(rows.map(normalizeAcc).filter(Boolean), { trips: [{ no: '171' }], nowMs: NOW });
  assert.deepEqual(campusOnly.map((x) => [x.id, x.where]), [['SAMPLE-1', 'campus'], ['SAMPLE-2', 'campus']]);
  // 12:01: 10~12시 행사는 끝나서 빠지고, 13시 행사는 3시간 안이라 '예정'으로 들어옴
  assert.deepEqual(matchIncidents(rows.map(normalizeAcc).filter(Boolean), { trips: [{ no: '171', path: PATH }], nowMs: kstMs('20261109', '1201') }).map((x) => [x.id, x.status]),
    [['SAMPLE-1', 'active'], ['LATER', 'soon']]);
});

test('정렬: 경로 위 → 국민대 근처, 진행 중 → 예정, 사고 → 집회 → 기상 → 공사, 가까운 순 · 최대 5건', () => {
  const at = (lat, lon) => { const t = latLonToTm(lat, lon); return { grs80tm_x: String(t.x), grs80tm_y: String(t.y) }; };
  const base = { occr_date: '20261109', occr_time: '0700', exp_clr_date: '20261109', exp_clr_time: '120000', acc_info: '테스트' };
  const rows = [
    { ...base, acc_id: 'w', acc_type: 'A04', ...at(37.6090, 127.0010) },
    { ...base, acc_id: 'a', acc_type: 'A01', ...at(37.6095, 126.9990) },
    { ...base, acc_id: 'wx', acc_type: 'A09', ...at(37.6100, 126.9980) },
    { ...base, acc_id: 'c', acc_type: 'A06', ...at(37.6150, 126.9930) }, // 국민대 근처(경로 밖)
    ...['1', '2', '3'].map((k) => ({ ...base, acc_id: `e${k}`, acc_type: 'A10', ...at(37.6086, 127.0005 + Number(k) * 0.0001) })),
  ];
  const items = matchIncidents(rows.map(normalizeAcc), { trips: [{ no: '171', path: PATH }], nowMs: NOW });
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((x) => x.id).slice(0, 2), ['a', 'e1']);
  assert.ok(items.every((x) => x.where === 'route'), '경로 위가 먼저 다 차면 국민대 근처는 밀려남');
});
