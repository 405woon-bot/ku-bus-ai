// 아주 단순한 JSON 파일 저장소(시제품용). 운영에서는 PostgreSQL·SQLite 등으로 바꾸세요.
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_ROUTES } from '../../shared/transitModel.js';
import { DEFAULT_MARGIN_MIN, DEFAULT_NOTIFY_BEFORE_MIN } from '../../shared/departure.js';

const ARS_ID = /^\d{5}$/;
const cut = (v, n) => String(v ?? '').trim().slice(0, n);
/**
 * 노선 설정 정리·검증. boardArsId = 내 승차 정류장 번호(5자리, 정류소정보조회의 arsId), alightName = 학교 하차 정류장 이름
 * @throws {Error} boardArsId 형식이 틀리면
 */
export function cleanRoute(r, i = 0) {
  const board = cut(r.boardArsId, 10);
  if (board && !ARS_ID.test(board)) throw new Error(`${cut(r.no, 10) || i + 1}번 노선: 승차 정류장 번호는 숫자 5자리예요`);
  const seq = Array.isArray(r.corridorSeq) && r.corridorSeq.length === 2 && r.corridorSeq.every(Number.isFinite) ? r.corridorSeq.map(Number) : undefined;
  const no = cut(r.no, 10);
  return {
    id: cut(r.id, 20) || no || `r${i}`, no, type: cut(r.type, 6), gate: r.gate === '후문' ? '후문' : '정문', stop: cut(r.stop, 30),
    usualMin: Math.max(1, Math.min(180, Number(r.usualMin) || 10)), corridor: cut(r.corridor, 20), ...(seq ? { corridorSeq: seq } : {}),
    enabled: r.enabled !== false, boardArsId: board, alightName: cut(r.alightName || r.stop, 30),
    ...(/^\d{6,12}$/.test(cut(r.busRouteId, 12)) ? { busRouteId: cut(r.busRouteId, 12) } : {}),
  };
}

export const defaultUser = () => ({
  classes: [
    { id: 's1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301' },
    { id: 's2', name: '자료구조', day: 2, start: '09:00', end: '10:15', building: '미래관', room: '301' },
    { id: 's3', name: '운영체제', day: 1, start: '10:30', end: '11:45', building: '북악관', room: '605' },
  ],
  routes: EXAMPLE_ROUTES.map((r, i) => cleanRoute(r, i)),   // boardArsId는 사용자가 설정(비어 있으면 예시 데이터로 계산)
  primaryRouteId: '171',
  settings: { marginMin: DEFAULT_MARGIN_MIN, notifyBeforeMin: DEFAULT_NOTIFY_BEFORE_MIN },
  walkOverrides: {},
  push: [],        // Web Push 구독 목록
  fired: {},       // `${dateKey}:${classId}` → 보낸 알림 기록
});

export function createStore(file) {
  let db = { users: {} };
  if (file && fs.existsSync(file)) { try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 깨진 파일이면 새로 시작 */ } }
  let timer = null;
  const persist = () => {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db, null, 1)); }, 200);
  };
  return {
    user(id) { if (!db.users[id]) { db.users[id] = defaultUser(); persist(); } return db.users[id]; },
    update(id, fn) { const u = this.user(id); fn(u); persist(); return u; },
    users() { return Object.entries(db.users); },
  };
}
