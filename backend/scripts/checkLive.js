// 실제 서울시 API를 불러 응답 형식과 계산 결과를 확인합니다(키는 출력하지 않음). backend/.env의 SEOUL_BUS_API_KEY 사용.
//   npm run check:live -- 정릉시장                 정류장 이름 검색 → 정류장 번호(arsId) 찾기
//   npm run check:live -- 08901                    탑승 정류장 번호 → 국민대로 가는 노선·차내 시간·정체 원인(화면과 같은 계산)
//   npm run check:live -- 171 08901 국민대학교앞     (v0.3 방식) 노선번호 · 승차 정류장 번호 · 하차 정류장 이름
import { createSeoulAdapter, createSeoulClient, parseStations } from '../src/transit/seoulBus.js';
import { createMemoryCache } from '../src/transit/cache.js';

const args = process.argv.slice(2);
const env = process.env;
const key = (env.SEOUL_BUS_API_KEY || '').trim();
if (!key) { console.log('backend/.env에 SEOUL_BUS_API_KEY를 넣어 주세요.'); process.exit(1); }
const opts = { key, baseUrl: env.SEOUL_BUS_BASE_URL || undefined, format: env.SEOUL_BUS_FORMAT === 'json' ? 'json' : 'xml' };
const step = async (title, fn) => { try { await fn(); } catch (e) { console.log(`✗ ${title}: [${e.kind || 'error'}] ${e.message}`); return e; } return null; };
const mmss = (s) => `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;

// 인증키 파라미터 이름 확인(ServiceKey → serviceKey 순서로): 가벼운 정류장 이름 검색으로 시험
let client;
for (const keyParam of [env.SEOUL_BUS_KEY_PARAM || 'ServiceKey', 'serviceKey']) {
  client = createSeoulClient({ ...opts, keyParam });
  const err = await step(`인증 확인(${keyParam})`, async () => {
    const r = await client.call('stationinfo/getStationByName', { stSrch: '국민대' });
    console.log(`✓ 인증 확인(${keyParam}, ${r.format}): headerCd=${r.code} ${r.message}`);
  });
  if (!err || err.kind !== 'auth') break;
}
const ad = createSeoulAdapter({ client, cache: createMemoryCache() });

if (args.length === 1 && !/^\d+$/.test(args[0])) {
  // ── 정류장 이름 검색 ──
  await step('정류장 검색 getStationByName', async () => {
    const stops = await ad.searchStops(args[0]);
    console.log(`✓ '${args[0]}' 정류장 ${stops.length}곳`);
    stops.slice(0, 15).forEach((s) => console.log(`   ${s.arsId}  ${s.name}  (${s.lat}, ${s.lon})`));
  });
} else if (args.length === 1) {
  // ── 탑승 정류장 → 국민대행 노선 ──
  const arsId = args[0];
  await step('도착 정보 getStationByUid', async () => {
    const r = await client.call('stationinfo/getStationByUid', { arsId });
    console.log(`✓ 정류장 ${arsId}: 노선 ${r.items.length}개 · 필드: ${Object.keys(r.items[0] || {}).sort().join(', ')}`);
    r.items.forEach((x) => console.log(`   ${x.rtNm} (노선ID ${x.busRouteId}) staOrd=${x.staOrd} term=${x.term ?? x.Term} · ${x.arrmsg1} (traTime1=${x.traTime1}) / ${x.arrmsg2 ?? ''}`));
  });
  await step('국민대행 노선 계산', async () => {
    const trips = await ad.stopTrips(arsId);
    if (!trips.length) console.log('✗ 이 정류장에서 국민대학교앞·국민대앞·국민대후문을 지나는 노선을 찾지 못했어요(정류장 이름이 다르면 shared/stopTrips.js의 KU_STOPS를 고치세요).');
    for (const t of trips) {
      console.log(`✓ ${t.no}번 → ${t.alightName}(${t.gate}) 차내 ${t.inVehicleMin.toFixed(1)}분 · ${t.distM} m · 중간 정류장 ${t.intermediateStops}곳 · 평균 ${Math.round(t.kmh)} km/h(${t.congestion})`
        + ` · 다음 차 ${t.etasSec.map(mmss).join(', ') || '정보 없음'}${t.cause ? ` · 정체 원인: ${t.cause}` : ''}`);
    }
  });
} else {
  // ── (v0.3 방식) 노선번호 · 승차 정류장 · 하차 정류장 ──
  const [no = '171', board = '', alight = '국민대학교앞'] = args;
  let id;
  await step('노선ID getBusRouteList', async () => { id = await ad.routeId(no); console.log(`✓ ${no}번 노선ID ${id}`); });
  if (id) await step('경유 정류소 getStaionByRoute', async () => {
    const r = await client.call('busRouteInfo/getStaionByRoute', { busRouteId: id });
    const st = parseStations(r.items);
    console.log(`✓ 정류장 ${st.length}곳 · 필드: ${Object.keys(r.items[0] || {}).sort().join(', ')}`);
    console.log(`   첫 행 fullSectDist=${r.items[0]?.fullSectDist} sectSpd=${r.items[0]?.sectSpd} / 마지막 행 fullSectDist=${r.items.at(-1)?.fullSectDist} (0인 쪽이 구간값이 없는 행)`);
    st.filter((s) => !board || s.arsId === board || /국민대/.test(s.name)).slice(0, 8).forEach((s) => console.log(`   ${s.seq}. ${s.name} (${s.arsId}) ${s.sectDistM} m · ${s.sectSpdKmh} km/h${s.turn ? ' · 회차' : ''}`));
  });
  if (board) {
    await step('차내 소요시간', async () => {
      const live = await ad.routeLive({ no, boardArsId: board, alightName: alight });
      console.log(`✓ ${live.board.name}(${live.board.seq}) → ${live.alight.name}(${live.alight.seq}): ${live.trip.minutes.toFixed(1)}분 (주행 ${live.trip.movingMin.toFixed(1)} + 정차 ${live.trip.intermediateStops}곳 × 20초), 가장 느린 구간 ${live.trip.slowest.from}→${live.trip.slowest.to} ${live.trip.slowest.kmh} km/h, 원인: ${live.cause?.text ?? '정체 없음'}`);
    });
  }
}
console.log(`API 호출 ${client.stats.calls}회`);
