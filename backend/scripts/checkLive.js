// 실제 서울시 API를 한 번씩 불러 응답 형식을 확인합니다(키는 출력하지 않음).
//   npm run check:live -- 171 08901 국민대학교앞      노선번호 · 내 승차 정류장 번호(arsId) · 하차 정류장 이름
import { createSeoulAdapter, createSeoulClient, parseStations } from '../src/transit/seoulBus.js';
import { createMemoryCache } from '../src/transit/cache.js';

const [no = '171', board = '', alight = '국민대학교앞'] = process.argv.slice(2);
const env = process.env;
const key = (env.SEOUL_BUS_API_KEY || '').trim();
if (!key) { console.log('backend/.env에 SEOUL_BUS_API_KEY를 넣어 주세요.'); process.exit(1); }
const opts = { key, baseUrl: env.SEOUL_BUS_BASE_URL || undefined, format: env.SEOUL_BUS_FORMAT === 'json' ? 'json' : 'xml' };
const step = async (title, fn) => { try { await fn(); } catch (e) { console.log(`✗ ${title}: [${e.kind || 'error'}] ${e.message}`); return e; } return null; };

// 인증키 파라미터 이름 확인(ServiceKey → serviceKey 순서로)
let client;
for (const keyParam of [env.SEOUL_BUS_KEY_PARAM || 'ServiceKey', 'serviceKey']) {
  client = createSeoulClient({ ...opts, keyParam });
  const err = await step(`노선 검색(${keyParam}) getBusRouteList`, async () => {
    const r = await client.call('busRouteInfo/getBusRouteList', { strSrch: no });
    console.log(`✓ 노선 검색 '${no}' (${keyParam}, ${r.format}): headerCd=${r.code} ${r.message} · ${r.items.length}건`);
    r.items.slice(0, 6).forEach((x) => console.log(`   ${x.busRouteNm}  노선ID ${x.busRouteId}  유형 ${x.routeType}  ${x.stStationNm} ↔ ${x.edStationNm}`));
  });
  if (!err || err.kind !== 'auth') break;
}
const ad = createSeoulAdapter({ client, cache: createMemoryCache() });
let id;
await step('노선ID', async () => { id = await ad.routeId(no); console.log(`✓ ${no}번 노선ID ${id}`); });
if (id) await step('경유 정류소 getStaionByRoute', async () => {
  const r = await client.call('busRouteInfo/getStaionByRoute', { busRouteId: id });
  const st = parseStations(r.items);
  console.log(`✓ 정류장 ${st.length}곳 · 필드: ${Object.keys(r.items[0] || {}).sort().join(', ')}`);
  console.log(`   첫 행 fullSectDist=${r.items[0]?.fullSectDist} sectSpd=${r.items[0]?.sectSpd} / 마지막 행 fullSectDist=${r.items.at(-1)?.fullSectDist} (0인 쪽이 구간값이 없는 행)`);
  st.filter((s) => !board || s.arsId === board || /국민대/.test(s.name)).slice(0, 8).forEach((s) => console.log(`   ${s.seq}. ${s.name} (${s.arsId}) ${s.sectDistM} m · ${s.sectSpdKmh} km/h${s.turn ? ' · 회차' : ''}`));
});
if (board) {
  await step('도착정보 getStationByUid', async () => {
    const r = await client.call('stationinfo/getStationByUid', { arsId: board });
    const it = r.items.find((x) => String(x.busRouteId) === String(id)) || r.items[0];
    console.log(`✓ 정류장 ${board}: ${r.items.length}개 노선 · 이 노선: ${it ? `${it.rtNm} ${it.arrmsg1} (traTime1=${it.traTime1}s) / ${it.arrmsg2} · staOrd=${it.staOrd}` : '없음'}`);
  });
  await step('차내 소요시간', async () => {
    const live = await ad.routeLive({ no, boardArsId: board, alightName: alight });
    console.log(`✓ ${live.board.name}(${live.board.seq}) → ${live.alight.name}(${live.alight.seq}): ${live.trip.minutes.toFixed(1)}분 (주행 ${live.trip.movingMin.toFixed(1)} + 정차 ${live.trip.intermediateStops}곳 × 20초), 가장 느린 구간 ${live.trip.slowest.from}→${live.trip.slowest.to} ${live.trip.slowest.kmh} km/h, 원인: ${live.cause?.text ?? '정체 없음'}`);
  });
}
console.log(`API 호출 ${client.stats.calls}회`);
